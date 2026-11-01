import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StackRole } from "@repo/core";

const h = vi.hoisted(() => ({
  projectOrg: "org_1",
  active: "dep_active" as string | null,
  depOrg: "org_1",
  depProject: "proj_1",
  roles: [] as StackRole[],
  refs: [] as Array<{ role: string; replica: number; containerId: string }>,
  find: vi.fn(),
  runtime: vi.fn(),
  sample: vi.fn(),
}));
vi.mock("@repo/db", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  repos: {
    project: {
      findById: async () => ({
        id: "proj_1",
        organizationId: h.projectOrg,
        activeDeploymentId: h.active,
      }),
    },
    deployment: { findById: h.find },
  },
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  withDeploymentRuntime: h.runtime,
}));
const { getRuntimeRoles, roleLogContainerId } =
  await import("@repo/platform/engine/modules/projects/project-roles");
const worker: StackRole = {
  name: "queue",
  kind: "worker",
  command: "exec php artisan queue:work",
  replicas: 2,
};
const scheduler: StackRole = {
  name: "scheduler",
  kind: "scheduler",
  command: "exec php artisan schedule:work",
};
const deployment = () => ({
  id: "dep_active",
  projectId: h.depProject,
  organizationId: h.depOrg,
  meta: { roles: h.roles },
  roleContainers: h.refs,
});
beforeEach(() => {
  vi.clearAllMocks();
  h.projectOrg = h.depOrg = "org_1";
  h.depProject = "proj_1";
  h.active = "dep_active";
  h.roles = [worker, scheduler];
  h.refs = [
    { role: "queue", replica: 1, containerId: "queue_1" },
    { role: "queue", replica: 2, containerId: "queue_2" },
    { role: "scheduler", replica: 1, containerId: "scheduler_1" },
  ];
  h.find.mockImplementation(async () => deployment());
  h.sample.mockResolvedValue({ state: "running", restartCount: 0, health: null });
  h.runtime.mockImplementation(async (_dep, run) =>
    run({
      supports: (capability: string) => capability === "stabilityProbe",
      sampleStability: h.sample,
    }),
  );
});

describe("active runtime role inventory (#1282)", () => {
  it("reports each worker/scheduler replica from the frozen active release and live probes", async () => {
    h.sample.mockImplementation(async (id: string) => ({
      state: id === "queue_2" ? "restarting" : "running",
      restartCount: id === "queue_2" ? 7 : 0,
      health: null,
    }));
    const result = await getRuntimeRoles("proj_1", "org_1");
    expect(h.find).toHaveBeenCalledWith("dep_active");
    expect(result.deploymentId).toBe("dep_active");
    expect(result.roles.map((role) => [role.name, role.kind, role.replicas])).toEqual([
      ["queue", "worker", 2],
      ["scheduler", "scheduler", 1],
    ]);
    expect(result.roles[0].containers).toEqual([
      { replica: 1, containerId: "queue_1", status: "running", restartCount: 0 },
      { replica: 2, containerId: "queue_2", status: "restarting", restartCount: 7 },
    ]);
    expect(result.error).toBeNull();
  });

  it("preserves recorded role containers when old metadata has no role definitions", async () => {
    h.roles = [];
    const result = await getRuntimeRoles("proj_1", "org_1");
    expect(result.roles[0]).toMatchObject({ name: "queue", kind: null, replicas: 2 });
    expect(result.roles[0].containers.every((replica) => replica.status === "running")).toBe(true);
  });

  it("does not infer a running replica when its reference or container is missing", async () => {
    h.refs = h.refs.filter((ref) => ref.containerId !== "queue_2");
    h.sample.mockResolvedValue({ state: "missing", restartCount: 0, health: null });
    const result = await getRuntimeRoles("proj_1", "org_1");
    expect(result.roles[0].containers).toEqual([
      { replica: 1, containerId: "queue_1", status: "missing", restartCount: null },
      { replica: 2, containerId: null, status: "missing", restartCount: null },
    ]);
  });

  it("reports unknown on a connection failure while preserving role identity", async () => {
    h.sample.mockRejectedValue(new Error("SSH is unreachable"));
    const result = await getRuntimeRoles("proj_1", "org_1");
    expect(result.error).toBeTruthy();
    expect(result.roles[0].containers[0]).toEqual({
      replica: 1,
      containerId: "queue_1",
      status: "unknown",
      restartCount: null,
    });
  });

  it.each([
    ["starting", "starting"],
    ["unhealthy", "failed"],
  ])("preserves a running process's health verdict: %s", async (health, status) => {
    h.sample.mockResolvedValue({ state: "running", restartCount: 0, health });
    expect((await getRuntimeRoles("proj_1", "org_1")).roles[0].containers[0].status).toBe(status);
  });

  it("does not connect to the runtime for projects without deployed roles", async () => {
    h.roles = [];
    h.refs = [];
    expect(await getRuntimeRoles("proj_1", "org_1")).toEqual({
      deploymentId: "dep_active",
      roles: [],
      error: null,
    });
    h.active = null;
    expect(await getRuntimeRoles("proj_1", "org_1")).toEqual({
      deploymentId: null,
      roles: [],
      error: null,
    });
    expect(h.runtime).not.toHaveBeenCalled();
  });

  it.each([
    ["other_project", "org_1"],
    ["proj_1", "other_org"],
  ])("refuses to use a foreign deployment pointer: %s / %s", async (project, org) => {
    h.depProject = project;
    h.depOrg = org;
    expect(await getRuntimeRoles("proj_1", "org_1")).toEqual({
      deploymentId: null,
      roles: [],
      error: null,
    });
    expect(h.runtime).not.toHaveBeenCalled();
  });

  it("rejects a foreign organization before reading deployment or runtime data", async () => {
    await expect(getRuntimeRoles("proj_1", "other_org")).rejects.toThrow();
    expect(h.find).not.toHaveBeenCalled();
    expect(h.runtime).not.toHaveBeenCalled();
  });
});

describe("role log selectors", () => {
  it("selects only a recorded replica from the active release", () => {
    expect(
      roleLogContainerId(deployment(), { role: "queue", replica: 2, deploymentId: "dep_active" }),
    ).toBe("queue_2");
    expect(roleLogContainerId(deployment(), { role: "scheduler" })).toBe("scheduler_1");
    expect(roleLogContainerId(deployment(), {})).toBeNull();
  });
  it.each([
    { role: "foreign" },
    { role: "queue", replica: 3 },
    { role: "queue", replica: 1, deploymentId: "dep_old" },
    { replica: 1 },
  ])("refuses invalid selectors instead of falling back to application logs: %j", (input) => {
    expect(() => roleLogContainerId(deployment(), input)).toThrow();
  });
});
