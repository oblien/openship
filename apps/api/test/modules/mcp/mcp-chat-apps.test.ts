import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { ChatAppsStatus, ChatAppSetup } from "@repo/contracts";
const forwarding = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../../src/app", () => ({ app: forwarding }));
import { seedOwner, repos, type SeededOwner } from "../jobs/_harness";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { chatAppRoutes } from "../../../src/modules/chat-apps/chat-apps.routes";
import { mcpRoutes } from "../../../src/modules/mcp/mcp.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { clientIpMiddleware } from "../../../src/middleware/client-ip";
import { shutdownRateLimit } from "../../../src/lib/rate-limit";
import { mcpTestClient } from "../../helpers/mcp-client";
import { resetMcpToolCache } from "../../../src/modules/mcp/mcp-tools";
const app = new Hono()
  .onError(handleApiError)
  .use("*", clientIpMiddleware)
  .route("/api/chat-apps", chatAppRoutes)
  .route("/api/mcp", mcpRoutes);
beforeAll(() => {
  vi.stubEnv("OPENSHIP_RATE_LIMIT_STORE", "memory");
  forwarding.fetch.mockImplementation((request: Request) => app.fetch(request));
  resetMcpToolCache();
});
afterAll(async () => {
  await shutdownRateLimit();
  vi.unstubAllEnvs();
});
async function scoped(owner: SeededOwner, settings: boolean) {
  const token = mintPatToken();
  const row = await repos.personalAccessToken.create({
    userId: owner.userId,
    organizationId: owner.orgId,
    name: "Chat app discovery",
    tokenPrefix: token.tokenPrefix,
    tokenHash: token.tokenHash,
    readOnly: true,
    scoped: true,
    expiresAt: null,
  });
  if (settings)
    await repos.patGrant.createMany(row.id, [
      { resourceType: "settings", resourceId: "*", permissions: ["read"] },
    ]);
  return {
    token: token.token,
    agent: mcpTestClient({
      request: (path, init) => app.request(path, init),
      token: token.token,
      organizationId: owner.orgId,
    }),
  };
}
async function connection(owner: SeededOwner, name: string) {
  return repos.chatApps.create({
    id: randomUUID(),
    userId: owner.userId,
    organizationId: owner.orgId,
    name,
    provider: "slack",
    purpose: "commands",
    transport: "outbound",
    origin: "http://localhost:4000",
    enabled: false,
    nativeId: "fixture",
  });
}
it("uses real MCP dispatch and settings grants for tenant-scoped connector discovery without exposing credentials", async () => {
  const owner = await seedOwner(),
    stranger = await seedOwner();
  const ours = await connection(owner, "Own Slack"),
    theirs = await connection(stranger, "Other private Slack");
  const { agent, token } = await scoped(owner, true);
  const list = await agent.rpc<{ tools: { name: string }[] }>("tools/list");
  expect(list.tools.map((t) => t.name)).toEqual(
    expect.arrayContaining(["get_chat_apps", "get_chat_apps_setup", "get_mcp_guide"]),
  );
  const { data } = await agent.call<{ data: ChatAppsStatus }>("get_chat_apps");
  expect(data.organizationId).toBe(owner.orgId);
  expect(data.connections.map((c) => c.id)).toEqual([ours.id]);
  expect(JSON.stringify(data)).not.toContain(theirs.name);
  expect(data.connections[0]).not.toHaveProperty("credentials");
  expect((await agent.result("get_chat_apps", { organizationId: stranger.orgId })).isError).toBe(
    true,
  );
  for (const [method, path, body] of [
    ["GET", `${ours.id}/configuration`, undefined],
    ["PATCH", ours.id, { enabled: true, revision: ours.revision }],
    ["POST", "pairing", { challenge: "a".repeat(32) }],
  ] as const) {
    const result = await app.request(`/api/chat-apps/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(result.status).toBe(403);
  }
  expect((await repos.chatApps.get(ours.id))?.enabled).toBe(false);
});
it("prepares the existing secure form without creating a bot and rejects invalid setup modes", async () => {
  const owner = await seedOwner(),
    { agent, token } = await scoped(owner, true);
  const { data } = await agent.call<{ data: ChatAppSetup }>("get_chat_apps_setup", {
    query: { provider: "slack", purpose: "commands" },
  });
  expect(data).toMatchObject({
    kind: "chat-app-setup",
    organizationId: owner.orgId,
    provider: "slack",
    purpose: "commands",
    transport: "outbound",
    created: false,
  });
  expect(data.fields.map((f) => f.key)).toEqual(["workspaceId", "botToken", "appToken"]);
  expect(data.setupPath).toBe(
    `/settings?tab=chat-apps&connect=slack&purpose=commands&transport=outbound&organizationId=${owner.orgId}`,
  );
  expect(await repos.chatApps.list(owner.orgId)).toEqual([]);
  for (const query of [
    { provider: "unknown" },
    { provider: "slack", botToken: "must-not-be-accepted" },
    { provider: "teams", transport: "outbound" },
  ])
    expect((await agent.result("get_chat_apps_setup", { query })).isError).toBe(true);
  for (const query of ["", "provider=unknown", "provider=slack&botToken=must-not-be-accepted"])
    expect(
      (
        await app.request(`/api/chat-apps/setup?${query}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(400);
});
it("keeps guides discoverable with zero grants while denying connection metadata", async () => {
  const owner = await seedOwner(),
    { agent } = await scoped(owner, false);
  const list = await agent.rpc<{ tools: { name: string }[] }>("tools/list");
  expect(list.tools.map((t) => t.name)).toContain("get_mcp_guide");
  expect(list.tools.map((t) => t.name)).not.toContain("get_chat_apps");
  expect((await agent.result("get_chat_apps")).isError).toBe(true);
  expect(
    (await agent.result("get_chat_apps_setup", { query: { provider: "slack" } })).isError,
  ).toBe(true);
  const guide = await agent.call("get_mcp_guide", { query: { name: "chat-apps" } });
  expect(JSON.stringify(guide)).toContain("get_chat_apps_setup");
  expect(JSON.stringify(guide)).toContain("do not require AI or Mindwire");
  expect((await agent.result("get_mcp_guide", { query: { name: "not-a-guide" } })).isError).toBe(
    true,
  );
});
