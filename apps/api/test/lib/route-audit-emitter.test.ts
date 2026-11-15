import { Hono } from "hono";
import { beforeEach, expect, it, vi } from "vitest";

const recordAsync = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/permission", async () => ({
  permission: { assert: async () => {} },
  ORG_SINGLETON_RESOURCES: new Set<string>(),
  isCheckedResourceType: (await import("@repo/platform")).isCheckedResourceType,
}));
vi.mock("@repo/db", () => ({ repos: {} }));
vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({ audit: { recordAsync } }));
vi.mock("@repo/platform/engine/modules/github/github-access", () => ({
  canUseGitHubRepo: async () => false,
  checkSourceTier: async () => ({ ok: false, readPaths: [] }),
}));

const { requirePermission } = await import("../../src/lib/route-permission");
const { internalSourceHeader, internalClientHeader } = await import("../../src/lib/call-source");
const { recordToolCall } = await import("../../src/modules/mcp/mcp-audit");
beforeEach(() => recordAsync.mockClear());

// Exercise both emitters through a real HTTP request; only auth and storage are stubbed.
it.each([
  ["pat", "rest", "project:read", 200, "project:read"],
  ["pat", "rest", "project:list", 200, "project:list"],
  ["cookie", "rest", "project:read", 200, null],
  ["pat", "rest", "project:write", 200, "project:write"],
  ["pat", "rest", "audit:read", 200, null],
  ["pat", "rest", "project:read", 404, null],
  ["pat", "operation", "project:read", 200, null],
  ["oauth", "rest", "project:read", 200, "project:read"],
  ["pat", "forged", "project:read", 200, "project:read"],
  ["pat", "mcp", "project:read", 200, "mcp.tool_called"],
  ["pat", "mcp", "project:list", 200, "mcp.tool_called"],
  ["oauth", "mcp", "project:read", 200, "mcp.tool_called"],
  ["oauth", "mcp", "project:list", 200, "mcp.tool_called"],
  ["pat", "mcp", "audit:read", 200, "mcp.tool_called"],
  ["pat", "mcp", "project:read", 403, "mcp.tool_called"],
  ["pat", "mcp", "project:write", 200, "project:write"],
  ["pat", "mcp", "project:write", 403, "mcp.tool_called"],
] as const)("%s %s %s (HTTP %i)", async (kind, channel, tag, status, eventType) => {
  const [root, action] = tag.split(":");
  const sessionId = kind === "cookie" ? "session-1" : `${kind}:client-1`;
  const handled = channel === "operation";
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set(
      "ctx" as never,
      {
        userId: "user-1",
        organizationId: "org-1",
        sessionId,
        sessionKind: kind === "cookie" ? "cookie" : "bearer",
        principalKind: kind === "cookie" ? null : kind,
      } as never,
    );
    c.set("scopedOrganizationId" as never, "org-1" as never);
    await next();
  });
  const method = action === "write" ? "POST" : "GET";
  app.on(method, "/:id", requirePermission({ tag, auditHandledByOperation: handled }), (c) => {
    if (handled) c.set("operationAuditRecorded" as never, true as never);
    return c.json({}, status);
  });
  const headers =
    channel === "mcp"
      ? { ...internalSourceHeader("mcp"), ...internalClientHeader(sessionId) }
      : channel === "forged"
        ? { "x-openship-call-source": "mcp.forged" }
        : {};
  const response = await app.request("/project-1", { method, headers });
  expect(response.status).toBe(status);
  if (channel === "mcp")
    recordToolCall(
      {
        organizationId: "org-1",
        userId: "user-1",
        clientId: sessionId,
        tokenId: "token-1",
        ipAddress: null,
        userAgent: null,
      },
      { tool: "test_tool", method, path: "/api/projects/:id", action, status, ok: response.ok },
    );

  expect(recordAsync).toHaveBeenCalledTimes(eventType ? 1 : 0);
  if (eventType)
    expect(recordAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceClientId: sessionId,
        source: channel === "mcp" || kind === "oauth" ? "mcp" : "api",
      }),
      expect.objectContaining({
        eventType,
        resourceType: eventType === "mcp.tool_called" ? "mcp_client" : root,
        resourceId:
          eventType === "mcp.tool_called" ? "token-1" : action === "list" ? "*" : "project-1",
      }),
    );
});
