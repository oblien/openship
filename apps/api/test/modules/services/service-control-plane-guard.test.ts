import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  project: {
    id: "proj_control_plane",
    organizationId: "org_1",
    slug: "openship",
    appTemplateId: "openship",
  },
  tenantProject: {
    id: "proj_tenant",
    organizationId: "org_1",
    slug: "my-app",
    appTemplateId: null,
  },
  deleted: false,
  stopped: false,
  restarted: false,
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: {
        ...actual.repos.project,
        findById: vi.fn(async (id: string) => {
          if (id === "proj_control_plane") return h.project;
          return h.tenantProject;
        }),
      },
    },
  };
});

vi.mock("../../../src/modules/services/service.service", () => ({
  deleteService: vi.fn(async () => {
    h.deleted = true;
  }),
  stopServiceContainer: vi.fn(async () => {
    h.stopped = true;
  }),
  restartServiceContainer: vi.fn(async () => {
    h.restarted = true;
    return { restarted: true };
  }),
}));

vi.mock("../../../src/lib/request-context", () => ({
  getRequestContext: () => ({
    userId: "user_1",
    organizationId: "org_1",
    role: "owner",
  }),
}));

import { stopContainer, restartContainer, remove } from "../../../src/modules/services/service.controller";

function mockContext(projectId: string, serviceId = "svc_1") {
  return {
    req: {
      param: (key: string) => (key === "id" ? projectId : serviceId),
      query: () => "",
    },
    json: (data: unknown, status = 200) => ({ data, status }),
  } as never;
}

describe("Service Controller - Control Plane Guard", () => {
  it("refuses to stop a service belonging to the OpenShip control plane", async () => {
    const c = mockContext("proj_control_plane");
    const res = (await stopContainer(c)) as { data: { code: string; error: string }; status: number };

    expect(res.status).toBe(403);
    expect(res.data.code).toBe("PROJECT_IS_CONTROL_PLANE");
    expect(res.data.error).toContain("cannot be stopped from the dashboard");
    expect(h.stopped).toBe(false);
  });

  it("refuses to restart a service belonging to the OpenShip control plane", async () => {
    const c = mockContext("proj_control_plane");
    const res = (await restartContainer(c)) as { data: { code: string; error: string }; status: number };

    expect(res.status).toBe(403);
    expect(res.data.code).toBe("PROJECT_IS_CONTROL_PLANE");
    expect(res.data.error).toContain("restart it via the CLI");
    expect(h.restarted).toBe(false);
  });

  it("refuses to delete a service belonging to the OpenShip control plane", async () => {
    const c = mockContext("proj_control_plane");
    const res = (await remove(c)) as { data: { code: string; error: string }; status: number };

    expect(res.status).toBe(403);
    expect(res.data.code).toBe("PROJECT_IS_CONTROL_PLANE");
    expect(res.data.error).toContain("cannot be deleted from the dashboard");
    expect(h.deleted).toBe(false);
  });

  it("permits operations on tenant workloads", async () => {
    const c = mockContext("proj_tenant");
    const res = (await stopContainer(c)) as { data: { success: boolean }; status: number };

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(h.stopped).toBe(true);
  });
});
