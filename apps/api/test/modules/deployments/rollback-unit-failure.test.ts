import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ makeActive: vi.fn(), setActive: vi.fn(), canRestore: true, inspectFails: false, bare: false, trigger: vi.fn() }));
const target = {
  id: "old", projectId: "project", organizationId: "org", status: "ready", pinned: false,
  artifactRetainedAt: new Date(), containerId: "unit-old", imageRef: null,
  commitSha: "old-commit", meta: { framework: "node" },
};
const active = { ...target, id: "live", containerId: "unit-live", commitSha: "live-commit" };
const project = { id: "project", organizationId: "org", activeDeploymentId: "live", defaultRollbackStrategy: "snapshot" };
vi.mock("@repo/db", () => ({
  withAdvisoryLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
  repos: {
    deployment: { findById: async (id: string) => id === "old" ? target : active },
    project: { findById: async () => project, setActiveDeployment: h.setActive },
    service: { listByDeployment: async () => [] },
    member: { listByOrganization: async () => [{ userId: "owner" }] },
  },
}));
vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  checkNoActiveBuild: async () => {}, triggerDeployment: h.trigger,
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", async () => {
  const { BareRuntime } = await import("@repo/adapters");
  const runtime = {
    supports: (cap: string) => cap === "unitRestore",
    makeActive: h.makeActive,
    dispose: async () => {},
    canRestoreUnit: async () => {
      if (h.inspectFails) throw new Error("Host unreachable");
      return h.canRestore;
    },
  };
  return { resolveDeploymentRuntime: async () => ({
    runtime: h.bare ? Object.assign(Object.create(BareRuntime.prototype), runtime) : runtime,
  }) };
});
import { resolveRestorePlan, rollback } from "@repo/platform/engine/modules/deployments/rollback/rollback-orchestrator";

it("restores the previous unit if activating the target fails, without moving the database pointer", async () => {
  h.bare = false;
  h.makeActive.mockRejectedValueOnce(new Error("Target failed to start")).mockResolvedValueOnce({ containerId: "unit-live" });
  await expect(rollback("old")).rejects.toThrow("Target failed to start");
  expect(h.makeActive.mock.calls.map(([input]) => [input.from.id, input.to.id])).toEqual([["live", "old"], ["old", "live"]]);
  expect(h.setActive).not.toHaveBeenCalled();
});

it("plans a rebuild for bare hosts without a restorable supervisor unit", async () => {
  h.bare = true;
  h.canRestore = false;
  expect((await resolveRestorePlan("old")).plan).toEqual({ mode: "rebuild", commitSha: "old-commit" });
});

it("does not promise a unit swap when inspecting the retained unit fails", async () => {
  h.bare = true;
  h.inspectFails = true;
  expect((await resolveRestorePlan("old")).plan).toEqual({ mode: "rebuild", commitSha: "old-commit" });
});
