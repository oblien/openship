import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeEdgeResponse, EDGE_RESPONSE_MAX_ROUTES } from "@repo/core";
import { createDatabase, createRepositories, schema, type DatabaseConnection } from "../factory";
import { createEncryption } from "../encryption";

describe("static response route persistence", () => {
  let connection: DatabaseConnection;
  let repos: ReturnType<typeof createRepositories>;
  let projectId: string;
  let domainId: string;
  beforeAll(async () => {
    connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
    repos = createRepositories(connection.db, createEncryption("response-route-test"));
    await connection.db
      .insert(schema.organization)
      .values({ id: "response-org", name: "Responses" });
    const group = await repos.projectGroup.create({
      organizationId: "response-org",
      name: "Routes",
      slug: "routes",
    });
    const project = await repos.project.create({
      organizationId: "response-org",
      groupId: group.id,
      name: "Routes",
      slug: "routes",
    });
    projectId = project.id;
    domainId = (
      await repos.domain.create({ projectId, hostname: "response.test", domainType: "custom" })
    ).id;
  });
  afterAll(async () => {
    await connection?.close();
  });
  const input = (pathPrefix: string | null, match: "exact" | "prefix" = "exact") => ({
    organizationId: "response-org",
    projectId,
    domainId,
    pathPrefix,
    spec: { response: normalizeEdgeResponse({ match, body: "original" }) },
    enabled: true,
  });
  it("serializes concurrent duplicate creates while permitting different match modes", async () => {
    const attempts = await Promise.allSettled([
      repos.routeRule.create(input("/race")),
      repos.routeRule.create(input("/race")),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "EDGE_RESPONSE_EXISTS" },
    });
    await expect(repos.routeRule.create(input("/race", "prefix"))).resolves.toMatchObject({
      pathPrefix: "/race",
    });
  });
  it("preserves response fields and prevents moving an existing route onto an occupied path", async () => {
    const first = await repos.routeRule.create(input("/first"));
    const second = await repos.routeRule.create(input("/second"));
    await repos.routeRule.update(first.id, { enabled: false });
    expect(await repos.routeRule.get(first.id)).toMatchObject({ enabled: false, spec: first.spec });
    await expect(repos.routeRule.update(second.id, { pathPrefix: "/first" })).rejects.toMatchObject(
      { code: "EDGE_RESPONSE_EXISTS" },
    );
    expect(await repos.routeRule.get(second.id)).toMatchObject({ pathPrefix: "/second" });
    await repos.routeRule.removeForProject("another-project", first.id);
    expect(await repos.routeRule.get(first.id)).toBeDefined();
    await repos.routeRule.removeForProject(projectId, first.id);
    expect(await repos.routeRule.get(first.id)).toBeUndefined();
  });
  it("enforces the per-domain bound under concurrent saves and allows editing a full domain", async () => {
    const boundedDomain = await repos.domain.create({
      projectId,
      hostname: "bounded.test",
      domainType: "custom",
    });
    for (let i = 0; i < EDGE_RESPONSE_MAX_ROUTES - 1; i++) {
      await repos.routeRule.create({
        ...input(`/bounded/${i}`),
        domainId: boundedDomain.id,
        enabled: false,
      });
    }
    const attempts = await Promise.allSettled(
      [0, 1].map((i) =>
        repos.routeRule.create({
          ...input(`/last/${i}`),
          domainId: boundedDomain.id,
        }),
      ),
    );
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "EDGE_RESPONSE_LIMIT" },
    });
    const rows = await repos.routeRule.listByDomain(boundedDomain.id);
    expect(rows).toHaveLength(EDGE_RESPONSE_MAX_ROUTES);
    await expect(repos.routeRule.update(rows[0]!.id, { enabled: true })).resolves.toBeUndefined();
    const other = await repos.routeRule.create(input("/move-to-full"));
    await expect(
      repos.routeRule.update(other.id, { domainId: boundedDomain.id }),
    ).rejects.toMatchObject({ code: "EDGE_RESPONSE_LIMIT" });
    expect((await repos.routeRule.get(other.id))?.domainId).toBe(domainId);
  });
});
