import { beforeEach, describe, expect, it, vi } from "vitest";

const assertPermission = vi.fn(async () => {});

vi.mock("../../src/lib/permission", () => ({
  permission: { assert: assertPermission },
  ORG_SINGLETON_RESOURCES: new Set<string>(),
}));
vi.mock("@repo/db", () => ({ repos: {} }));
vi.mock("../../src/lib/audit", () => ({
  audit: vi.fn(async () => {}),
  auditContextFrom: vi.fn(() => ({})),
}));
vi.mock("@repo/platform/engine/modules/github/github-access", () => ({
  canUseGitHubRepo: vi.fn(async () => false),
  checkSourceTier: vi.fn(async () => ({ ok: false, readPaths: [] })),
}));

const { requirePermission } = await import("../../src/lib/route-permission");

function context(params: Record<string, string | undefined>) {
  const values = new Map<string, unknown>([["ctx", { userId: "user-1" }]]);
  return {
    req: {
      param: vi.fn((name: string) => params[name]),
      query: vi.fn(() => undefined),
    },
    get: vi.fn((name: string) => values.get(name)),
    set: vi.fn((name: string, value: unknown) => values.set(name, value)),
    json: vi.fn((body: unknown, status: number) => ({ body, status })),
    res: { status: 200 },
  };
}

describe("nested list permission scope", () => {
  beforeEach(() => assertPermission.mockClear());

  it("delegates body-derived authorization only when the adapter applies its operation context", async () => {
    const c = context({});
    const next = vi.fn(async () => {
      c.set("operationContextApplied", true);
      c.set("operationAuditRecorded", true);
    });
    await requirePermission({ tag: "server:admin", authorizationHandledByOperation: true, auditHandledByOperation: true })(c as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(assertPermission).not.toHaveBeenCalled();
  });

  it("rejects a successful operation-authorized adapter that omitted its context", async () => {
    const c = context({});
    await expect(requirePermission({ tag: "server:read", authorizationHandledByOperation: true })(c as never, async () => {}))
      .rejects.toThrow("did not apply its authorized context");
  });

  it("preserves operation refusal responses before an authorized context is available", async () => {
    const c = context({});
    c.res.status = 404;
    await expect(requirePermission({ tag: "server:admin", authorizationHandledByOperation: true })(c as never, async () => {})).resolves.toBeUndefined();
    expect(assertPermission).not.toHaveBeenCalled();
  });

  it("requires and authorizes the explicit query project for domain collections", async () => {
    const c = context({});
    const next = vi.fn(async () => {});
    const check = requirePermission({ tag: "domain:list", collectionProject: "query" });
    expect(await check(c as never, next)).toMatchObject({ status: 400 });
    expect(next).not.toHaveBeenCalled();
    c.req.query.mockImplementation((name: string) => name === "projectId" ? "project-1" : undefined);
    await check(c as never, next);
    expect(assertPermission).toHaveBeenCalledWith(expect.anything(), {
      resourceType: "project", resourceId: "project-1", action: "read",
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it.each(["project:service:list", "project:deployment:list"])(
    "authorizes %s against the concrete parent project",
    async (tag) => {
      const c = context({ id: "project-1" });
      const next = vi.fn(async () => {});

      await requirePermission({ tag })(c as never, next);

      expect(assertPermission).toHaveBeenCalledWith(
        expect.anything(),
        { resourceType: "project", resourceId: "project-1", action: "read" },
      );
      expect(next).toHaveBeenCalledOnce();
    },
  );

  it("keeps a top-level list on its org-scoped wildcard", async () => {
    const c = context({});
    const next = vi.fn(async () => {});

    await requirePermission({ tag: "project:list" })(c as never, next);

    expect(assertPermission).toHaveBeenCalledWith(
      expect.anything(),
      { resourceType: "project", resourceId: "*", action: "read", scope: "list" },
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("authorizes nested collection writes through their parent without an org-wide service grant", async () => {
    const c = context({ id: "project-1" });
    const next = vi.fn(async () => { c.set("operationAuditRecorded", true); });
    await requirePermission({ tag: "project:service:write", collection: true, auditHandledByOperation: true })(c as never, next);
    expect(assertPermission).toHaveBeenCalledWith(expect.anything(), { resourceType: "project", resourceId: "project-1", action: "write" });
    expect(next).toHaveBeenCalledOnce();
  });

  it("fails closed when a nested list has no parent id", async () => {
    const c = context({});
    const next = vi.fn(async () => {});

    const response = await requirePermission({ tag: "project:service:list" })(c as never, next);

    expect(response).toEqual(expect.objectContaining({ status: 400 }));
    expect(assertPermission).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

// The application seams moved with the shared engine.
vi.mock("@repo/platform/engine/lib/authorization", async (importOriginal) => {
  const mocked = await (() => ({
  permission: { assert: assertPermission },
  ORG_SINGLETON_RESOURCES: new Set<string>(),
}))(importOriginal);
  return { ...mocked, authorization: mocked.authorization ?? { authorize: async (ctx, input) => { await mocked.permission.assert(ctx, input); return ctx; } } };
});

vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({
  audit: vi.fn(async () => {}),
  auditContextFrom: vi.fn(() => ({})),
}));
