import { beforeAll, describe, expect, it } from "vitest";
import { makeApp, req, seedEvent, seedMember, seedOwner, seedProject } from "./_harness";
import type { SeededOwner } from "./_harness";

/**
 * The audit log had no filters at all: one page of 50 rows, one dropdown of
 * hardcoded event types, and a search box that only matched text already on
 * screen. The three questions people actually ask of it — "what did the AI
 * assistant do", "what did this person do", "what happened last Tuesday" — were
 * all unanswerable.
 *
 * These run against the real router and a real (in-memory) Postgres, because the
 * parts most likely to break are the parts a mock would paper over: a category is
 * not a column (it expands to `event_type IN (...)`), `source` is a new column
 * with a new index, and `q` has to reach rows that only ever stored an opaque id.
 */

const app = makeApp();

let owner: SeededOwner;
let sarah: SeededOwner;
let other: SeededOwner; // a second org — nothing of theirs may ever appear
let projectId: string;

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

beforeAll(async () => {
  owner = await seedOwner("Ada Owner");
  sarah = await seedMember(owner.orgId, "admin", "Sarah Admin");
  other = await seedOwner("Other Org Owner");

  projectId = await seedProject(owner.orgId, "api-gateway");

  // A history with a bit of everything: two actors, four sources, three days.
  await seedEvent({
    organizationId: owner.orgId,
    eventType: "deployment.succeeded",
    actorUserId: owner.userId,
    resourceType: "project",
    resourceId: projectId,
    source: "dashboard",
    createdAt: ago(0),
  });
  await seedEvent({
    organizationId: owner.orgId,
    eventType: "deployment.failed",
    actorUserId: sarah.userId,
    resourceType: "project",
    resourceId: projectId,
    source: "mcp",
    createdAt: ago(1),
  });
  await seedEvent({
    organizationId: owner.orgId,
    eventType: "project.created",
    actorUserId: sarah.userId,
    resourceType: "project",
    resourceId: projectId,
    source: "mcp",
    createdAt: ago(2),
  });
  await seedEvent({
    organizationId: owner.orgId,
    eventType: "domain.added",
    actorUserId: owner.userId,
    resourceType: "domain",
    resourceId: "dom_1",
    source: "cli",
    createdAt: ago(10),
  });
  await seedEvent({
    organizationId: owner.orgId,
    eventType: "server.unreachable",
    actorUserId: null,
    resourceType: "server",
    resourceId: "srv_1",
    source: "system",
    createdAt: ago(40),
  });
  // Pre-migration row: no source at all. Must stay visible in the unfiltered
  // feed and must not be swept into any particular source.
  await seedEvent({
    organizationId: owner.orgId,
    eventType: "settings.updated",
    actorUserId: owner.userId,
    resourceType: "settings",
    resourceId: "*",
    source: null,
    createdAt: ago(3),
  });
  await seedEvent({
    organizationId: other.orgId,
    eventType: "deployment.succeeded",
    actorUserId: other.userId,
    source: "mcp",
    createdAt: ago(0),
  });
});

/** Event types returned for a query string, newest first. */
async function types(query: string, auth = () => owner.auth): Promise<string[]> {
  const res = await req(app, "GET", query, { auth: auth() });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.map((r: { eventType: string }) => r.eventType);
}

describe("the feed, unfiltered", () => {
  it("returns this org's rows only, newest first", async () => {
    const res = await req(app, "GET", "/", { auth: owner.auth });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(6); // the 7th belongs to the other org
    expect(res.body.data.map((r: { eventType: string }) => r.eventType)).toEqual([
      "deployment.succeeded",
      "deployment.failed",
      "project.created",
      "settings.updated",
      "domain.added",
      "server.unreachable",
    ]);
  });

  it("resolves the resource NAME so a row can say api-gateway, not prj_xxx", async () => {
    const res = await req(app, "GET", "/", { auth: owner.auth });
    const row = res.body.data.find((r: { eventType: string }) => r.eventType === "deployment.succeeded");
    expect(row.resourceName).toBe("api-gateway");
    // Unnameable resources come back null rather than blocking the page.
    const server = res.body.data.find((r: { eventType: string }) => r.eventType === "server.unreachable");
    expect(server.resourceName).toBeNull();
  });

  it("resolves the actor, and leaves system rows actorless", async () => {
    const res = await req(app, "GET", "/", { auth: owner.auth });
    const row = res.body.data.find((r: { eventType: string }) => r.eventType === "deployment.failed");
    expect(row.actor).toMatchObject({ id: sarah.userId, name: "Sarah Admin" });
    const system = res.body.data.find((r: { eventType: string }) => r.eventType === "server.unreachable");
    expect(system.actor).toBeNull();
  });
});

describe("source — the MCP filter", () => {
  it("isolates what the AI assistant did", async () => {
    expect(await types("/?source=mcp")).toEqual(["deployment.failed", "project.created"]);
  });

  it("excludes MCP rows from every other source", async () => {
    expect(await types("/?source=dashboard")).toEqual(["deployment.succeeded"]);
    expect(await types("/?source=cli")).toEqual(["domain.added"]);
    expect(await types("/?source=system")).toEqual(["server.unreachable"]);
  });

  it("never leaks another org's MCP activity", async () => {
    const res = await req(app, "GET", "/?source=mcp", { auth: owner.auth });
    expect(res.body.total).toBe(2);
    const theirs = await req(app, "GET", "/?source=mcp", { auth: other.auth });
    expect(theirs.body.total).toBe(1);
  });

  it("ignores a source that is not one of ours instead of returning nothing", async () => {
    // A hand-edited URL degrades to unfiltered — better than an empty feed that
    // looks like "nothing ever happened".
    expect(await types("/?source=totally-made-up")).toHaveLength(6);
  });
});

describe("category — expanded server-side, because it is not a column", () => {
  it("returns only the event types belonging to the category", async () => {
    expect(await types("/?category=deployments")).toEqual([
      "deployment.succeeded",
      "deployment.failed",
    ]);
    expect(await types("/?category=domains")).toEqual(["domain.added"]);
    expect(await types("/?category=servers")).toEqual(["server.unreachable"]);
    expect(await types("/?category=apps")).toEqual(["project.created"]);
  });

  it("treats `all` as no filter", async () => {
    expect(await types("/?category=all")).toHaveLength(6);
  });

  it("degrades a stale category to unfiltered rather than 400-ing", async () => {
    expect(await types("/?category=deleted-tab")).toHaveLength(6);
  });

  it("composes with source", async () => {
    expect(await types("/?category=deployments&source=mcp")).toEqual(["deployment.failed"]);
  });
});

describe("actor — the who-did-this filter", () => {
  it("narrows to one person", async () => {
    expect(await types(`/?actorUserId=${sarah.userId}`)).toEqual([
      "deployment.failed",
      "project.created",
    ]);
  });

  it("composes with category", async () => {
    expect(await types(`/?actorUserId=${sarah.userId}&category=apps`)).toEqual(["project.created"]);
  });
});

describe("date range", () => {
  it("bounds the window with from", async () => {
    const from = ago(5).toISOString();
    expect(await types(`/?from=${from}`)).toEqual([
      "deployment.succeeded",
      "deployment.failed",
      "project.created",
      "settings.updated",
    ]);
  });

  it("bounds the window with to", async () => {
    const to = ago(5).toISOString();
    expect(await types(`/?to=${to}`)).toEqual(["domain.added", "server.unreachable"]);
  });

  it("bounds both ends", async () => {
    expect(await types(`/?from=${ago(20).toISOString()}&to=${ago(5).toISOString()}`)).toEqual([
      "domain.added",
    ]);
  });

  it("ignores an unparseable date", async () => {
    expect(await types("/?from=last-tuesday")).toHaveLength(6);
  });
});

describe("search", () => {
  it("matches the event type", async () => {
    expect(await types("/?q=deployment")).toEqual(["deployment.succeeded", "deployment.failed"]);
  });

  it("matches the ACTOR by name — the row stores only a user id", async () => {
    expect(await types("/?q=Sarah")).toEqual(["deployment.failed", "project.created"]);
  });

  it("matches the actor by email", async () => {
    expect(await types(`/?q=${sarah.userId}@test.local`)).toEqual([
      "deployment.failed",
      "project.created",
    ]);
  });

  it("matches a RESOURCE by name — rows store prj_xxx, people search api-gateway", async () => {
    const found = await types("/?q=api-gateway");
    expect(found).toContain("deployment.succeeded");
    expect(found).toContain("project.created");
    expect(found).not.toContain("server.unreachable");
  });

  it("composes with the other filters", async () => {
    expect(await types("/?q=api-gateway&source=mcp&category=apps")).toEqual(["project.created"]);
  });
});

describe("pagination", () => {
  it("reports the filtered total, not the org total", async () => {
    // The "1–50 of N" line has to agree with the filter, or paging past the end
    // shows an empty page.
    const res = await req(app, "GET", "/?source=mcp&perPage=1", { auth: owner.auth });
    expect(res.body.total).toBe(2);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.page).toBe(1);
  });

  it("keeps the filter on the second page", async () => {
    const res = await req(app, "GET", "/?source=mcp&perPage=1&page=2", { auth: owner.auth });
    expect(res.body.data.map((r: { eventType: string }) => r.eventType)).toEqual(["project.created"]);
  });
});

describe("facets — one request drives the whole filter bar", () => {
  it("counts every category and lists the actors and sources present", async () => {
    const res = await req(app, "GET", "/facets", { auth: owner.auth });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(6);
    const counts = Object.fromEntries(
      res.body.categories.map((c: { id: string; count: number }) => [c.id, c.count]),
    );
    expect(counts).toMatchObject({ deployments: 2, apps: 1, domains: 1, servers: 1, system: 1 });
    const sources = Object.fromEntries(
      res.body.sources.map((s: { source: string | null; count: number }) => [s.source, s.count]),
    );
    expect(sources).toMatchObject({ mcp: 2, dashboard: 1, cli: 1, system: 1 });
    // The pre-migration row is counted under an explicit null, not folded into a
    // source it never had.
    expect(sources).toHaveProperty("null", 1);
    expect(res.body.actors.map((a: { name: string }) => a.name).sort()).toEqual([
      "Ada Owner",
      "Sarah Admin",
    ]);
  });

  it("counts each facet with the OTHER filters applied but not its own", async () => {
    // Otherwise picking "MCP" zeroes every other source and the choice becomes a
    // one-way door: nothing left to click back to.
    const res = await req(app, "GET", "/facets?source=mcp", { auth: owner.auth });
    const counts = Object.fromEntries(
      res.body.categories.map((c: { id: string; count: number }) => [c.id, c.count]),
    );
    expect(counts.deployments).toBe(1); // category counts DO respect source
    expect(counts.domains).toBe(0);
    const sources = Object.fromEntries(
      res.body.sources.map((s: { source: string | null; count: number }) => [s.source, s.count]),
    );
    expect(sources.dashboard).toBe(1); // source counts do NOT respect source
    expect(sources.mcp).toBe(2);
  });

  it("applies the same rule to the category filter", async () => {
    const res = await req(app, "GET", "/facets?category=deployments", { auth: owner.auth });
    const counts = Object.fromEntries(
      res.body.categories.map((c: { id: string; count: number }) => [c.id, c.count]),
    );
    expect(counts.domains).toBe(1); // still reachable: category ignores itself
    const sources = Object.fromEntries(
      res.body.sources.map((s: { source: string | null; count: number }) => [s.source, s.count]),
    );
    expect(sources).toMatchObject({ dashboard: 1, mcp: 1 }); // sources respect category
    expect(sources.cli).toBeUndefined();
  });

  it("reports the recording settings and whether the caller may change them", async () => {
    const res = await req(app, "GET", "/facets", { auth: owner.auth });
    expect(res.body.settings).toMatchObject({ enabled: true, retentionDays: 90 });
    expect(res.body.canManage).toBe(true);
  });
});
