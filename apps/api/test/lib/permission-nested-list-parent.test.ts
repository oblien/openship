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
vi.mock("../../src/modules/github/github-access", () => ({
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

  it("fails closed when a nested list has no parent id", async () => {
    const c = context({});
    const next = vi.fn(async () => {});

    const response = await requirePermission({ tag: "project:service:list" })(c as never, next);

    expect(response).toEqual(expect.objectContaining({ status: 400 }));
    expect(assertPermission).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
