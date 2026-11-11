import { beforeEach, describe, expect, it, vi } from "vitest";

const assertPermission = vi.fn(async () => {});
const { recordAsyncMock } = vi.hoisted(() => ({ recordAsyncMock: vi.fn() }));

vi.mock("../../src/lib/permission", async () => ({
  permission: { assert: assertPermission },
  ORG_SINGLETON_RESOURCES: new Set<string>(),
  isCheckedResourceType: (await import("@repo/platform")).isCheckedResourceType,
}));
vi.mock("@repo/db", () => ({ repos: {} }));
// Both the route and MCP emitters use this sink. Keep their real attribution
// and audit predicates so the combined path catches duplicate or missing rows.
vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({
  audit: { record: vi.fn(), recordAsync: recordAsyncMock },
}));
vi.mock("@repo/platform/engine/modules/github/github-access", () => ({
  canUseGitHubRepo: vi.fn(async () => false),
  checkSourceTier: vi.fn(async () => ({ ok: false, readPaths: [] })),
}));

const { requirePermission } = await import("../../src/lib/route-permission");
const { internalSourceHeader, internalClientHeader } = await import("../../src/lib/call-source");
const { recordToolCall } = await import("../../src/modules/mcp/mcp-audit");

/**
 * A PAT-authenticated REST call must leave an audit row that says WHICH
 * token made it, and a successful read made with a token must leave a row
 * at all — the same "what did it look at" question MCP already answers
 * for its reads. A browser read stays unaudited: reads are too noisy to
 * log for every dashboard page view.
 */
function context(opts: {
  params?: Record<string, string | undefined>;
  ctx?: Record<string, unknown>;
  status?: number;
  headers?: Record<string, string>;
}) {
  const values = new Map<string, unknown>([
    ["ctx", { userId: "user-1", organizationId: "org-1", ...(opts.ctx ?? {}) }],
    ["scopedOrganizationId", "org-1"],
  ]);
  return {
    req: {
      param: vi.fn((name: string) => (opts.params ?? {})[name]),
      query: vi.fn(() => undefined),
      header: vi.fn((name: string) => opts.headers?.[name]),
    },
    var: { clientIp: "127.0.0.1" },
    get: vi.fn((name: string) => values.get(name)),
    set: vi.fn((name: string, value: unknown) => values.set(name, value)),
    json: vi.fn((body: unknown, status: number) => ({ body, status })),
    res: { status: opts.status ?? 200 },
  };
}

const patCtx = { sessionKind: "bearer", principalKind: "pat", sessionId: "pat:pat_123" };
const oauthCtx = { sessionKind: "bearer", principalKind: "oauth", sessionId: "oauth:cli_abc" };
const cookieCtx = { sessionKind: "cookie", principalKind: null, sessionId: "sess_abc" };

describe("route audit emitter", () => {
  beforeEach(() => {
    assertPermission.mockClear();
    recordAsyncMock.mockClear();
  });

  it("audits a PAT read and stamps the token id on the row", async () => {
    const c = context({ params: { id: "project-1" }, ctx: patCtx });
    await requirePermission({ tag: "project:read" })(c as never, async () => {});

    expect(recordAsyncMock).toHaveBeenCalledOnce();
    expect(recordAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceClientId: "pat:pat_123", source: "api" }),
      expect.objectContaining({
        eventType: "project:read",
        resourceType: "project",
        resourceId: "project-1",
      }),
    );
  });

  it("audits a PAT list under the wildcard resource", async () => {
    const c = context({ ctx: patCtx });
    await requirePermission({ tag: "project:list" })(c as never, async () => {});

    expect(recordAsyncMock).toHaveBeenCalledOnce();
    expect(recordAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceClientId: "pat:pat_123" }),
      expect.objectContaining({ eventType: "project:list", resourceId: "*" }),
    );
  });

  it("does not audit a browser read", async () => {
    const c = context({ params: { id: "project-1" }, ctx: cookieCtx });
    await requirePermission({ tag: "project:read" })(c as never, async () => {});

    expect(recordAsyncMock).not.toHaveBeenCalled();
  });

  it("keeps auditing PAT writes with the token id", async () => {
    const c = context({ params: { id: "project-1" }, ctx: patCtx });
    await requirePermission({ tag: "project:write" })(c as never, async () => {});

    expect(recordAsyncMock).toHaveBeenCalledOnce();
    expect(recordAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceClientId: "pat:pat_123" }),
      expect.objectContaining({ eventType: "project:write", resourceId: "project-1" }),
    );
  });

  it("does not audit a PAT read of the audit log itself (no self-audit loop)", async () => {
    const c = context({ ctx: patCtx });
    await requirePermission({ tag: "audit:read" })(c as never, async () => {});

    expect(recordAsyncMock).not.toHaveBeenCalled();
  });

  it("does not audit a failed PAT read", async () => {
    const c = context({ params: { id: "project-1" }, ctx: patCtx, status: 404 });
    await requirePermission({ tag: "project:read" })(c as never, async () => {});

    expect(recordAsyncMock).not.toHaveBeenCalled();
  });

  it("skips the emitter when the operation already recorded the call", async () => {
    const c = context({ params: { id: "project-1" }, ctx: patCtx });
    const next = vi.fn(async () => {
      c.set("operationAuditRecorded", true);
    });
    await requirePermission({ tag: "project:read", auditHandledByOperation: true })(
      c as never,
      next,
    );

    expect(recordAsyncMock).not.toHaveBeenCalled();
  });

  it("audits a direct OAuth REST read even though its derived source is mcp", async () => {
    const c = context({ params: { id: "project-1" }, ctx: oauthCtx });
    await requirePermission({ tag: "project:read" })(c as never, async () => {});
    expect(recordAsyncMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sourceClientId: "oauth:cli_abc" }),
      expect.objectContaining({ eventType: "project:read" }),
    );
  });

  it("does not let a forged MCP claim suppress a REST read", async () => {
    const c = context({
      params: { id: "project-1" },
      ctx: patCtx,
      headers: { "x-openship-call-source": "mcp.forged" },
    });
    await requirePermission({ tag: "project:read" })(c as never, async () => {});
    expect(recordAsyncMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ source: "api", sourceClientId: "pat:pat_123" }),
      expect.objectContaining({ eventType: "project:read" }),
    );
  });

  it.each([
    { principal: patCtx, action: "read", root: "project", status: 200, event: "mcp.tool_called" },
    { principal: patCtx, action: "list", root: "project", status: 200, event: "mcp.tool_called" },
    { principal: oauthCtx, action: "read", root: "project", status: 200, event: "mcp.tool_called" },
    { principal: oauthCtx, action: "list", root: "project", status: 200, event: "mcp.tool_called" },
    { principal: patCtx, action: "read", root: "audit", status: 200, event: "mcp.tool_called" },
    { principal: patCtx, action: "read", root: "project", status: 403, event: "mcp.tool_called" },
    { principal: patCtx, action: "write", root: "project", status: 200, event: "project:write" },
    { principal: patCtx, action: "write", root: "project", status: 403, event: "mcp.tool_called" },
  ])(
    "records one MCP $principal.principalKind $action on $root (HTTP $status)",
    async ({ principal, action, root, status, event }) => {
      const c = context({
        params: { id: "project-1" },
        ctx: principal,
        status,
        headers: { ...internalSourceHeader("mcp"), ...internalClientHeader(principal.sessionId) },
      });
      await requirePermission({ tag: `${root}:${action}` })(c as never, async () => {});
      recordToolCall(
        {
          organizationId: "org-1",
          userId: "user-1",
          clientId: principal.sessionId,
          tokenId: "token-1",
          ipAddress: null,
          userAgent: null,
        },
        {
          tool: "test_tool",
          method: action === "write" ? "POST" : "GET",
          path: `/api/${root}`,
          action,
          status,
          ok: status < 400,
        },
      );
      expect(recordAsyncMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ source: "mcp", sourceClientId: principal.sessionId }),
        expect.objectContaining({ eventType: event }),
      );
    },
  );
});
