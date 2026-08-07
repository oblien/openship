import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fix B, reconcile-path hole (Fable's finding).
 *
 * `resolveActiveContainerId` gates "is this multi-service?" on
 * `meta.serviceDeploymentMode` (written at deployment CREATE time), NOT on
 * `meta.composeDeployment` (written only by onSuccess's happy-path metaPatch). A
 * compose deploy that settles via the RECONCILE path (connection loss) never
 * gets the `composeDeployment` marker — and if the loss hit before the exposed
 * app came up, its recorded parent is the topo-first DB container. Gating on the
 * success-only marker therefore left logs/enable/disable acting on the DB again.
 * This proves the create-time gate closes that.
 */

const h = vi.hoisted(() => ({
  listByDeploymentCalls: 0,
  serviceRows: [] as Array<{ serviceId: string; containerId: string | null }>,
  projectServices: [] as Array<{ id: string; exposed: boolean }>,
}));

vi.mock("@repo/db", () => ({
  repos: {
    service: {
      listByDeployment: async () => {
        h.listByDeploymentCalls += 1;
        return h.serviceRows;
      },
      listByProject: async () => h.projectServices,
    },
  },
}));

const { resolveActiveContainerId } = await import(
  "../../../src/modules/projects/project-runtime.service"
);

beforeEach(() => {
  h.listByDeploymentCalls = 0;
  // db first (topo dependency order); app is the exposed one.
  h.serviceRows = [
    { serviceId: "db", containerId: "cid-db" },
    { serviceId: "app", containerId: "cid-app" },
  ];
  h.projectServices = [
    { id: "app", exposed: true },
    { id: "db", exposed: false },
  ];
});

describe("resolveActiveContainerId — reconcile-path gate", () => {
  it("resolves the exposed app for a reconcile-settled compose dep (no composeDeployment marker)", async () => {
    const resolved = await resolveActiveContainerId("prj_1", {
      id: "dep_1",
      containerId: "cid-db", // the mis-recorded topo-first DB
      meta: { serviceDeploymentMode: "services" }, // note: NO composeDeployment
    });
    expect(resolved).toBe("cid-app");
  });

  it("still resolves the app when the recorded parent is the 'compose' sentinel", async () => {
    const resolved = await resolveActiveContainerId("prj_1", {
      id: "dep_1",
      containerId: "compose",
      meta: { serviceDeploymentMode: "services" },
    });
    expect(resolved).toBe("cid-app");
  });

  it("trusts the recorded container for an explicit single-app deploy, without querying", async () => {
    const resolved = await resolveActiveContainerId("prj_1", {
      id: "dep_1",
      containerId: "cid-single",
      meta: { serviceDeploymentMode: "single" },
    });
    expect(resolved).toBe("cid-single");
    expect(h.listByDeploymentCalls).toBe(0); // single-app short-circuits — no reconcile queries
  });
});
