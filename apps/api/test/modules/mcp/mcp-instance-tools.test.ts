import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { db, eq, schema } from "@repo/db";

const fixture = vi.hoisted(() => ({
  fetch: vi.fn(),
  inspect: vi.fn(async () => ({
    ok: true,
    db: { driver: "fixture", ok: true, latencyMs: 1, error: null, migrationsApplied: 1 },
    projects: { total: 2, apps: 2 },
    servicesConfigured: 2,
    hostChannel: null,
  })),
}));
vi.mock("../../../src/app", () => ({ app: { fetch: fixture.fetch } }));
vi.mock("@repo/platform/engine/modules/system/system-health", () => ({
  inspectSystemHealth: fixture.inspect,
}));

import { seedOwner, repos, type SeededOwner } from "../jobs/_harness";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { systemManagementRoutes } from "../../../src/modules/system/system-management.routes";
import { mcpRoutes } from "../../../src/modules/mcp/mcp.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { clientIpMiddleware } from "../../../src/middleware/client-ip";
import { shutdownRateLimit } from "../../../src/lib/rate-limit";
import { mcpTestClient } from "../../helpers/mcp-client";

const app = new Hono()
  .onError(handleApiError)
  .use("*", clientIpMiddleware)
  .route("/api/system", systemManagementRoutes)
  .route("/api/mcp", mcpRoutes);
const client = (owner: SeededOwner, token = owner.token) =>
  mcpTestClient({
    request: (path, init) => app.request(path, init),
    token,
    organizationId: owner.orgId,
  });
beforeAll(() => {
  vi.stubEnv("OPENSHIP_RATE_LIMIT_STORE", "memory");
  fixture.fetch.mockImplementation((request: Request) => app.fetch(request));
});
afterAll(async () => {
  await shutdownRateLimit();
  vi.unstubAllEnvs();
});
const names = async (agent: ReturnType<typeof client>) =>
  (await agent.rpc<{ tools: { name: string }[] }>("tools/list")).tools.map((t) => t.name);

it("does not offer instance diagnostics to a workspace-bound connection, even after full workspace access", async () => {
  const owner = await seedOwner({ instanceAdmin: true, bound: true });
  const agent = client(owner);
  const visible = await names(agent);
  expect(visible).toContain("get_system_settings");
  for (const name of [
    "get_system_diagnostics",
    "get_system_browse",
    "get_system_edge_untracked",
    "post_system_edge_untracked_remove",
  ])
    expect(visible).not.toContain(name);
  fixture.inspect.mockClear();
  const result = await agent.result<{ code: string }>("get_system_diagnostics");
  expect(result.isError).toBe(true);
  expect(result.data.code).toBe("INSTANCE_SCOPE_REQUIRED");
  expect(fixture.inspect).not.toHaveBeenCalled();
});

it("allows a read-only instance administrator and observes role revocation on the next request", async () => {
  const owner = await seedOwner({ instanceAdmin: true, bound: false });
  const token = mintPatToken();
  await repos.personalAccessToken.create({
    userId: owner.userId,
    organizationId: null,
    name: "Read instance",
    tokenPrefix: token.tokenPrefix,
    tokenHash: token.tokenHash,
    scoped: false,
    readOnly: true,
    expiresAt: null,
  });
  const agent = client(owner, token.token);
  expect(await names(agent)).toContain("get_system_diagnostics");
  expect(await names(agent)).not.toContain("post_system_edge_untracked_remove");
  const result = await agent.call<{ ok: boolean }>("get_system_diagnostics");
  expect(result.ok).toBe(true);
  expect(fixture.inspect).toHaveBeenCalled();
  await db.update(schema.user).set({ role: "user" }).where(eq(schema.user.id, owner.userId));
  expect(await names(agent)).not.toContain("get_system_diagnostics");
  fixture.inspect.mockClear();
  expect((await agent.result("get_system_diagnostics")).isError).toBe(true);
  expect(fixture.inspect).not.toHaveBeenCalled();
});

it("cannot turn explicit settings grants into instance authority or another workspace's authority", async () => {
  const owner = await seedOwner({ instanceAdmin: true });
  const token = mintPatToken();
  const binding = await repos.personalAccessToken.create({
    userId: owner.userId,
    organizationId: owner.orgId,
    name: "Workspace assistant",
    tokenPrefix: token.tokenPrefix,
    tokenHash: token.tokenHash,
    scoped: true,
    readOnly: true,
    expiresAt: null,
  });
  await repos.patGrant.createMany(binding.id, [
    { resourceType: "settings", resourceId: "*", permissions: ["read", "admin"] },
  ]);
  const agent = client(owner, token.token);
  expect(await names(agent)).not.toContain("get_system_diagnostics");
  const other = await seedOwner();
  expect(
    (await agent.result("get_system_diagnostics", { organizationId: other.orgId })).isError,
  ).toBe(true);
});
