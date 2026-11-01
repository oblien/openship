import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";

const forwarding = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../../src/app", () => ({ app: forwarding }));
import { seedOwner, seedServer, repos, type SeededOwner } from "../jobs/_harness";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { analyticsRoutes } from "../../../src/modules/analytics/analytics.routes";
import { migrationRoutes } from "../../../src/modules/migration/migration.routes";
import { mcpRoutes } from "../../../src/modules/mcp/mcp.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { clientIpMiddleware } from "../../../src/middleware/client-ip";
import { shutdownRateLimit } from "../../../src/lib/rate-limit";
import { mcpTestClient } from "../../helpers/mcp-client";

const app = new Hono()
  .onError(handleApiError)
  .use("*", clientIpMiddleware)
  .route("/api/analytics", analyticsRoutes)
  .route("/api/migration", migrationRoutes)
  .route("/api/mcp", mcpRoutes);
const client = (owner: SeededOwner, token = owner.token) =>
  mcpTestClient({
    request: (path, init) => app.request(path, init),
    token,
    organizationId: owner.orgId,
  });
beforeAll(() => {
  vi.stubEnv("OPENSHIP_RATE_LIMIT_STORE", "memory");
  forwarding.fetch.mockImplementation((request: Request) => app.fetch(request));
});
afterAll(async () => {
  await shutdownRateLimit();
  vi.unstubAllEnvs();
});
async function project(owner: SeededOwner, name: string) {
  const input = { organizationId: owner.orgId, name, slug: `${name}-${randomUUID()}` };
  const group = await repos.projectGroup.create(input);
  return repos.project.create({ ...input, groupId: group.id, gitProvider: "upload" });
}
async function scoped(owner: SeededOwner, projectId: string, analytics: boolean) {
  const token = mintPatToken();
  const row = await repos.personalAccessToken.create({
    userId: owner.userId,
    organizationId: owner.orgId,
    name: "MCP analytics",
    tokenPrefix: token.tokenPrefix,
    tokenHash: token.tokenHash,
    readOnly: true,
    scoped: true,
    expiresAt: null,
  });
  await repos.patGrant.createMany(row.id, [
    { resourceType: "project", resourceId: projectId, permissions: ["read"] },
    ...(analytics
      ? [{ resourceType: "analytics" as const, resourceId: "*", permissions: ["read" as const] }]
      : []),
  ]);
  return client(owner, token.token);
}

it("requires analytics authority AND access to the queried project through real MCP/auth/operations", async () => {
  const owner = await seedOwner();
  const visible = await project(owner, "visible"),
    hidden = await project(owner, "hidden");
  const agent = await scoped(owner, visible.id, true);
  const tools = await agent.rpc<{ tools: { name: string }[] }>("tools/list");
  expect(tools.tools.map((tool) => tool.name)).toContain("get_analytics");
  const summary = await agent.call<{ data: { totalRequests: number } }>("get_analytics", {
    query: { projectId: visible.id },
  });
  expect(summary.data.totalRequests).toBe(0);
  expect((await agent.result("get_analytics", { query: { projectId: hidden.id } })).isError).toBe(
    true,
  );
  const stranger = await seedOwner();
  const foreign = await project(stranger, "foreign");
  expect((await agent.result("get_analytics", { query: { projectId: foreign.id } })).isError).toBe(
    true,
  );
  const noAnalytics = await scoped(owner, visible.id, false);
  expect(
    (await noAnalytics.rpc<{ tools: { name: string }[] }>("tools/list")).tools.map(
      (tool) => tool.name,
    ),
  ).not.toContain("get_analytics");
  expect(
    (await noAnalytics.result("get_analytics", { query: { projectId: visible.id } })).isError,
  ).toBe(true);
});

it("masks an active migration's saved environment without mutating its recovery snapshot", async () => {
  const owner = await seedOwner(),
    serverId = await seedServer(owner.orgId);
  const snapshot = {
    serviceEnv: {
      api: { DATABASE_URL: "postgres://private-fixture-password", TOKEN: "private-fixture-token" },
    },
    serviceNames: ["api"],
  };
  const run = await repos.dockerMigrationRun.create({
    id: randomUUID(),
    organizationId: owner.orgId,
    sourceServerId: serverId,
    targetServerId: serverId,
    projectName: "Migration fixture",
    status: "awaiting_cutover",
    inputSnapshot: snapshot,
    confirmationToken: "fixture-confirmation",
  });
  expect(run).toBeDefined();
  const agent = client(owner);
  const active = await agent.call<{
    run: { id: string; inputSnapshot: unknown };
    confirmationToken: string;
  }>("get_migration_active", { query: { serverId } });
  expect(active.run.id).toBe(run!.id);
  expect(active.confirmationToken).toBe("fixture-confirmation");
  expect(JSON.stringify(active.run.inputSnapshot)).not.toContain("private-fixture");
  const detail = await agent.call<{ run: { inputSnapshot: unknown } }>(
    "get_migration_migrations_by_id",
    { id: run!.id },
  );
  expect(detail.run.inputSnapshot).toEqual(active.run.inputSnapshot);
  expect((await repos.dockerMigrationRun.findById(run!.id))?.inputSnapshot).toEqual(snapshot);
  const stranger = client(await seedOwner());
  const hidden = await stranger.result<{ code: string }>("get_migration_active", { query: { serverId } });
  expect(hidden.isError).toBe(true);
  expect(hidden.data.code).toBe("NOT_FOUND");
  expect(JSON.stringify(hidden.data)).not.toContain(run!.id);
  expect((await stranger.result("get_migration_migrations_by_id", { id: run!.id })).isError).toBe(
    true,
  );
});
