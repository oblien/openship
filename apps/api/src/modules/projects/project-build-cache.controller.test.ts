import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const h = vi.hoisted(() => ({
  findProject: vi.fn(),
  permission: vi.fn(async () => {}),
  assertInstanceAdmin: vi.fn(async () => {}),
  clearBuildCache: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: { ...actual.repos.project, findById: h.findProject },
    },
  };
});

vi.mock("../../lib/request-context", () => ({
  getRequestContext: () => ({ userId: "user_1", organizationId: "org_1" }),
}));

vi.mock("../../lib/permission", () => ({
  permission: { assert: h.permission },
}));

vi.mock("../../lib/audit", () => ({
  audit: { recordAsync: h.audit },
  auditContextFrom: () => ({}),
}));

vi.mock("@repo/platform/engine/lib/instance-authorization", () => ({
  instanceAuthorization: { assert: h.assertInstanceAdmin },
}));

vi.mock("@repo/platform/engine/modules/deployments/build-cache-gc", () => ({
  clearProjectBuildCache: h.clearBuildCache,
}));

import { clearBuildCache } from "./project.controller";

function app() {
  const api = new Hono();
  api.post("/projects/:id/clear-build", clearBuildCache);
  return api;
}

describe("project build-cache controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findProject.mockResolvedValue({
      id: "proj_1",
      organizationId: "org_1",
      cloudWorkspaceId: null,
      serverId: "srv_1",
      activeDeploymentId: null,
    });
    h.clearBuildCache.mockResolvedValue({
      target: "server",
      serverId: "srv_1",
      cachesDeleted: ["cache-a", "cache-b"],
      spaceReclaimed: 8192,
    });
  });

  it("requires project admin, clears the resolved host and returns reclaimed bytes", async () => {
    const response = await app().request("/projects/proj_1/clear-build", { method: "POST" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      hostScoped: true,
      target: "server",
      serverId: "srv_1",
      cachesDeleted: 2,
      bytesReclaimed: 8192,
    });
    expect(h.permission).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org_1" }),
      { resourceType: "project", resourceId: "proj_1", action: "admin" },
    );
    expect(h.assertInstanceAdmin).toHaveBeenCalledOnce();
    expect(h.clearBuildCache).toHaveBeenCalledWith(expect.objectContaining({ id: "proj_1" }));
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "user_1", organizationId: "org_1", source: "api" }),
      expect.objectContaining({
        eventType: "project.build_cache.cleared",
        resourceId: "proj_1",
        after: expect.objectContaining({ hostScoped: true, bytesReclaimed: 8192 }),
      }),
    );
  });
});

// The application seams moved with the shared engine.
vi.mock("@repo/platform/engine/lib/authorization", () => ({
  authorization: { authorize: async (ctx: import("@repo/platform").ExecutionContext, input: import("@repo/platform").PermissionInput) => {
    await Reflect.apply(h.permission, undefined, [ctx, input]);
    return ctx;
  } },
}));

vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({
  audit: { recordAsync: h.audit },
  auditContextFrom: () => ({}),
}));
