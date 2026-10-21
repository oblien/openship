import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { OpenshipClient } from "@repo/sdk/client";
import { repos, seedOwner, type SeededOwner } from "../jobs/_harness";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { domainRoutes } from "../../../src/modules/domains/domain.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/domains", domainRoutes);

function client(actor: SeededOwner) {
  return new OpenshipClient({
    baseUrl: "http://openship.test",
    token: actor.token,
    organizationId: actor.orgId,
    fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
  });
}

const get = (actor: SeededOwner, query: string) =>
  app.request(`/api/domains?${query}`, {
    headers: { ...actor.auth, "x-organization-id": actor.orgId },
  });

async function seed() {
  const actor = await seedOwner();
  const group = await repos.projectGroup.create({
    organizationId: actor.orgId,
    name: "paged",
    slug: `${actor.orgId}-paged`,
  });
  const project = await repos.project.create({
    organizationId: actor.orgId,
    groupId: group.id,
    name: "paged",
    slug: `${actor.orgId}-paged`,
  });
  const service = await repos.service.create({
    projectId: project.id,
    name: "web",
    kind: "compose",
    image: "nginx:alpine",
    enabled: true,
    exposed: true,
    exposedPort: "4000",
    ports: ["4000"],
  });
  const label = project.id.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const host = (name: string) => `${name}.${label}.example.org`;
  const rows = [
    { hostname: host("delta"), status: "active" },
    {
      hostname: host("alpha"),
      status: "pending",
      serviceId: service.id,
      targetPort: 4000,
      boundByDomain: true,
    },
    { hostname: host("charlie"), status: "failed", serviceId: service.id, targetPort: 4000 },
    {
      hostname: host("bravo-tenant"),
      status: "pending",
      serviceId: service.id,
      targetPort: 4000,
      boundByDomain: true,
    },
    { hostname: host("echo-tenant"), status: "active" },
  ];
  for (const row of rows)
    await repos.domain.create({ projectId: project.id, domainType: "custom", ...row });
  return { actor, project, service, host, hostnames: rows.map((row) => row.hostname).sort() };
}

describe("GET /api/domains paging", () => {
  it("keeps the unpaged response when no paging or filter parameter is sent", async () => {
    const s = await seed();
    const response = await get(s.actor, `projectId=${s.project.id}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(["data"]);
    expect(body.data.map((row: { hostname: string }) => row.hostname).sort()).toEqual(s.hostnames);
    expect(await client(s.actor).domains.list(s.project.id)).toHaveLength(5);
  });

  it("walks every row once in hostname order through nextCursor", async () => {
    const s = await seed();
    const ship = client(s.actor);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await ship.domains.listPage(s.project.id, { limit: 2, cursor });
      expect(page.domains.length).toBeLessThanOrEqual(2);
      seen.push(...page.domains.map((row) => row.hostname));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual(s.hostnames);
    expect(pages).toBe(3);
    const last = await (await get(s.actor, `projectId=${s.project.id}&limit=5`)).json();
    expect(last.data).toHaveLength(5);
    expect(last.nextCursor).toBeUndefined();
  });

  it("filters by hostname text, status, service and row binding", async () => {
    const s = await seed();
    const ship = client(s.actor);
    const names = async (input: Parameters<typeof ship.domains.listPage>[1]) =>
      (await ship.domains.listPage(s.project.id, input)).domains.map((row) => row.hostname);
    expect(await names({ limit: 50, q: "TENANT" })).toEqual([
      s.host("bravo-tenant"),
      s.host("echo-tenant"),
    ]);
    // LIKE wildcards in the search text are literal characters.
    expect(await names({ limit: 50, q: "%" })).toEqual([]);
    expect(await names({ limit: 50, q: "_" })).toEqual([]);
    expect(await names({ limit: 50, status: "active" })).toEqual([
      s.host("delta"),
      s.host("echo-tenant"),
    ]);
    expect(await names({ limit: 50, serviceId: s.service.id })).toEqual([
      s.host("alpha"),
      s.host("bravo-tenant"),
      s.host("charlie"),
    ]);
    expect(await names({ limit: 50, bound: true })).toEqual([
      s.host("alpha"),
      s.host("bravo-tenant"),
    ]);
    expect(await names({ limit: 50, bound: false, status: "active" })).toEqual([
      s.host("delta"),
      s.host("echo-tenant"),
    ]);
    const http = await (await get(s.actor, `projectId=${s.project.id}&bound=true&q=tenant`)).json();
    expect(http.data.map((row: { hostname: string }) => row.hostname)).toEqual([
      s.host("bravo-tenant"),
    ]);
  });

  it("rejects malformed paging input and other organizations' projects", async () => {
    const s = await seed();
    for (const query of ["limit=0", "limit=201", "limit=abc", "bound=yes", "status=unknown"])
      expect((await get(s.actor, `projectId=${s.project.id}&${query}`)).status).toBe(400);
    const other = await seedOwner();
    expect((await get(other, `projectId=${s.project.id}&limit=10`)).status).toBe(404);
  });
});
