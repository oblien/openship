/**
 * "What did THIS agent do."
 *
 * `source` could already answer "what did an AI assistant do", which was enough
 * while one connection per user was the norm. With two — Claude Desktop and Cursor,
 * or a personal client beside a CI one — every row still read identically, so the
 * question a reader actually has when something unexpected appears ("which of these
 * do I revoke?") had no answer, and the log could not distinguish an agent that
 * deployed on request from one looping unattended.
 *
 * `source_client_id` holds the canonical principal id the auth layer already mints
 * (`oauth:<clientId>` / `pat:<tokenId>`), so a name comes from a table that already
 * exists. These run against the real router and a real (in-memory) Postgres because
 * the parts most likely to break are the ones a mock hides: a partial index, a
 * facet counted without its own filter, and two name lookups across two tables.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@repo/db";
import { repos } from "@repo/db";
import { mintPatToken } from "../../../src/lib/pat";
import { makeApp, req, seedEvent, seedOwner } from "./_harness";
import type { SeededOwner } from "./_harness";

const app = makeApp();

let owner: SeededOwner;
let other: SeededOwner;
/** `pat:<id>` for a static-token MCP connection — no OAuth app to name it. */
let patClient: string;

// The stored column holds the PREFIXED principal id; the oauth_application row is
// keyed by the bare client_id. Keeping both spellings explicit is deliberate —
// conflating them is exactly how a name lookup silently resolves to nothing.
const DESKTOP_CLIENT = "cli_desktop";
const CURSOR_CLIENT = "cli_cursor";
const DESKTOP = `oauth:${DESKTOP_CLIENT}`;
const CURSOR = `oauth:${CURSOR_CLIENT}`;
/** A client id with nothing behind it — a disconnected, still-audited agent. */
const GHOST = "oauth:cli_gone";

/** Register an OAuth application so its clientId resolves to a display name. */
async function seedOauthApp(clientId: string, name: string, userId: string) {
  await db.insert(schema.oauthApplication).values({
    id: `app_${clientId}`,
    name,
    clientId,
    redirectUrls: "http://localhost/callback",
    type: "public",
    userId,
  });
}

beforeAll(async () => {
  owner = await seedOwner("Ada Owner");
  other = await seedOwner("Other Org Owner");

  await seedOauthApp(DESKTOP_CLIENT, "Claude Desktop", owner.userId);
  await seedOauthApp(CURSOR_CLIENT, "Cursor", owner.userId);

  const pat = mintPatToken();
  const row = await repos.personalAccessToken.create({
    userId: owner.userId,
    organizationId: owner.orgId,
    name: "CI agent token",
    tokenPrefix: pat.tokenPrefix,
    tokenHash: pat.tokenHash,
    readOnly: false,
    scoped: false,
    expiresAt: null,
  });
  patClient = `pat:${row.id}`;

  // Desktop: three calls, one of them a refused write. Cursor: one read.
  await seedEvent({
    organizationId: owner.orgId,
    eventType: "mcp.tool_called",
    actorUserId: owner.userId,
    resourceType: "mcp_client",
    source: "mcp",
    sourceClientId: DESKTOP,
  });
  await seedEvent({
    organizationId: owner.orgId,
    eventType: "mcp.tool_called",
    actorUserId: owner.userId,
    source: "mcp",
    sourceClientId: DESKTOP,
  });
  await seedEvent({
    organizationId: owner.orgId,
    eventType: "project:write",
    actorUserId: owner.userId,
    resourceType: "project",
    source: "mcp",
    sourceClientId: DESKTOP,
  });
  await seedEvent({
    organizationId: owner.orgId,
    eventType: "mcp.tool_called",
    actorUserId: owner.userId,
    source: "mcp",
    sourceClientId: CURSOR,
  });
  await seedEvent({
    organizationId: owner.orgId,
    eventType: "mcp.tool_called",
    actorUserId: owner.userId,
    source: "mcp",
    sourceClientId: patClient,
  });
  await seedEvent({
    organizationId: owner.orgId,
    eventType: "mcp.tool_called",
    actorUserId: owner.userId,
    source: "mcp",
    sourceClientId: GHOST,
  });
  // An MCP row from before attribution existed, plus an ordinary dashboard row.
  await seedEvent({
    organizationId: owner.orgId,
    eventType: "mcp.authorized",
    actorUserId: owner.userId,
    source: "mcp",
  });
  await seedEvent({
    organizationId: owner.orgId,
    eventType: "deployment.succeeded",
    actorUserId: owner.userId,
    source: "dashboard",
  });
  // Another org's agent — must never appear, however the filter is spelled.
  await seedEvent({
    organizationId: other.orgId,
    eventType: "mcp.tool_called",
    actorUserId: other.userId,
    source: "mcp",
    sourceClientId: DESKTOP,
  });
});

describe("filtering to one agent", () => {
  it("returns only that client's rows", async () => {
    const res = await req(app, "GET", `/?sourceClientId=${encodeURIComponent(DESKTOP)}`, {
      auth: owner.auth,
    });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    for (const row of res.body.data) expect(row.sourceClientId).toBe(DESKTOP);
  });

  it("excludes the other agent, and MCP rows with no attribution at all", async () => {
    const res = await req(app, "GET", `/?sourceClientId=${encodeURIComponent(CURSOR)}`, {
      auth: owner.auth,
    });
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].eventType).toBe("mcp.tool_called");
  });

  it("never crosses the org boundary", async () => {
    // The same clientId is connected in both orgs — the only thing keeping them
    // apart is the org predicate, so this is the case worth stating.
    const res = await req(app, "GET", `/?sourceClientId=${encodeURIComponent(DESKTOP)}`, {
      auth: other.auth,
    });
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].actorUserId).toBe(other.userId);
  });

  it("composes with the other filters", async () => {
    const res = await req(
      app,
      "GET",
      `/?sourceClientId=${encodeURIComponent(DESKTOP)}&category=agent`,
      { auth: owner.auth },
    );
    // The refused-write row (project:write) is Desktop's but not in the agent
    // category, so the two filters intersect rather than either winning.
    expect(res.body.total).toBe(2);
  });

  it("degrades to unfiltered on a malformed id rather than 400-ing", async () => {
    // Same contract as an unknown category: a stale bookmark still renders a feed.
    const res = await req(app, "GET", "/?sourceClientId=not-a-principal-id", { auth: owner.auth });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(8);
  });
});

describe("naming the agent", () => {
  it("resolves an OAuth client id to the registered application name", async () => {
    const res = await req(app, "GET", `/?sourceClientId=${encodeURIComponent(DESKTOP)}`, {
      auth: owner.auth,
    });
    for (const row of res.body.data) expect(row.sourceClientName).toBe("Claude Desktop");
  });

  it("resolves a static-token connection to the token's name", async () => {
    // A PAT-backed client has no OAuth application, so the token name is the only
    // label there is — and without it these rows would show a raw pat_ id.
    const res = await req(app, "GET", `/?sourceClientId=${encodeURIComponent(patClient)}`, {
      auth: owner.auth,
    });
    expect(res.body.data[0].sourceClientName).toBe("CI agent token");
  });

  it("keeps a row whose client no longer exists, with a null name", async () => {
    const res = await req(app, "GET", `/?sourceClientId=${encodeURIComponent(GHOST)}`, {
      auth: owner.auth,
    });
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].sourceClientId).toBe(GHOST);
    expect(res.body.data[0].sourceClientName).toBeNull();
  });

  it("leaves unattributed rows null instead of inventing an agent", async () => {
    const res = await req(app, "GET", "/?eventType=deployment.succeeded", { auth: owner.auth });
    expect(res.body.data[0].sourceClientId).toBeNull();
    expect(res.body.data[0].sourceClientName).toBeNull();
  });

  it("resolves both id kinds in ONE page without an N+1", async () => {
    const res = await req(app, "GET", "/?source=mcp", { auth: owner.auth });
    const byClient = new Map<string, string | null>(
      res.body.data.map((r: { sourceClientId: string | null; sourceClientName: string | null }) => [
        r.sourceClientId ?? "none",
        r.sourceClientName,
      ]),
    );
    expect(byClient.get(DESKTOP)).toBe("Claude Desktop");
    expect(byClient.get(CURSOR)).toBe("Cursor");
    expect(byClient.get(patClient)).toBe("CI agent token");
    expect(byClient.get("none")).toBeNull();
  });
});

describe("the agent facet", () => {
  it("lists the agents that appear, busiest first, with counts and names", async () => {
    const res = await req(app, "GET", "/facets", { auth: owner.auth });
    const clients = res.body.clients as { id: string; name: string | null; count: number }[];
    expect(clients[0]).toMatchObject({ id: DESKTOP, name: "Claude Desktop", count: 3 });
    expect(clients.map((c) => c.id).sort()).toEqual([CURSOR, DESKTOP, GHOST, patClient].sort());
    expect(clients.find((c) => c.id === GHOST)).toMatchObject({ name: null, count: 1 });
  });

  it("never lists a null client — an unattributed row is not an agent", async () => {
    const res = await req(app, "GET", "/facets", { auth: owner.auth });
    const clients = res.body.clients as { id: string | null }[];
    expect(clients.every((c) => !!c.id)).toBe(true);
  });

  it("counts each agent WITHOUT its own filter, so the choice is reversible", async () => {
    // The same rule the source facet follows: picking Desktop must leave Cursor
    // clickable, or the filter is a one-way door.
    const res = await req(app, "GET", `/facets?sourceClientId=${encodeURIComponent(DESKTOP)}`, {
      auth: owner.auth,
    });
    const clients = res.body.clients as { id: string; count: number }[];
    expect(clients.find((c) => c.id === CURSOR)?.count).toBe(1);
    // ...while the category counts DO respect it.
    const counts = Object.fromEntries(
      res.body.categories.map((c: { id: string; count: number }) => [c.id, c.count]),
    );
    expect(counts.agent).toBe(2);
    expect(counts.deployments).toBe(0);
  });

  it("respects the other filters", async () => {
    const res = await req(app, "GET", "/facets?category=deployments", { auth: owner.auth });
    expect(res.body.clients).toEqual([]);
  });

  it("is empty for an org with no agents", async () => {
    const res = await req(app, "GET", "/facets", { auth: other.auth });
    expect((res.body.clients as unknown[]).length).toBe(1); // other org has its own one row
  });
});

describe("the agent category", () => {
  it("collects the whole MCP lifecycle, tool calls included", async () => {
    const res = await req(app, "GET", "/?category=agent", { auth: owner.auth });
    const types = new Set(res.body.data.map((r: { eventType: string }) => r.eventType));
    expect(types).toContain("mcp.tool_called");
    expect(types).toContain("mcp.authorized");
    // A write an agent made is filed under what it changed, not under the agent —
    // that row already says "project:write" and names the project.
    expect(types).not.toContain("project:write");
  });
});
