import { describe, expect, it, vi } from "vitest";
import {
  planSwarmManagedResourceGc,
  retainedSwarmResourceRefs,
  runSwarmManagedResourceGcSweep,
  SWARM_MANAGED_RESOURCE_GRACE_MS,
} from "./resource-retention.service";
import { MANAGED_RESOURCE_CREATED_AT_LABEL } from "../../swarm/swarm-managed-resources";

const labels = {
  "com.openship.swarm.managed-resource": "true",
  "com.openship.swarm.project-id": "project-a",
  [MANAGED_RESOURCE_CREATED_AT_LABEL]: "2026-07-20T00:00:00.000Z",
};

describe("Swarm managed resource retention", () => {
  it("retains ready, active, and in-flight revision refs", () => {
    const refs = retainedSwarmResourceRefs([
      { id: "ready", applyStatus: "ready", configRefs: ["config-ready"], secretRefs: ["secret-ready"] },
      { id: "in-flight", applyStatus: "converging", configRefs: ["config-in-flight"], secretRefs: [] },
      { id: "active-partial", applyStatus: "partial", configRefs: [], secretRefs: ["secret-active"] },
      { id: "failed", applyStatus: "failed", configRefs: ["config-failed"], secretRefs: ["secret-failed"] },
    ] as never, "active-partial");
    expect([...refs.configs].sort()).toEqual(["config-in-flight", "config-ready"]);
    expect([...refs.secrets].sort()).toEqual(["secret-active", "secret-ready"]);
  });

  it("only selects aged, OpenShip-labelled, unreferenced manager objects", () => {
    const now = new Date("2026-07-30T12:00:00.000Z");
    const plan = planSwarmManagedResourceGc({
      projectId: "project-a",
      discovery: {
        configs: [
          { id: "1", name: "config-kept", labels, createdAt: "2026-07-20T00:00:00.000Z" },
          { id: "2", name: "config-expired", labels, createdAt: "2026-07-20T00:00:00.000Z" },
          { id: "3", name: "config-young", labels: { ...labels, [MANAGED_RESOURCE_CREATED_AT_LABEL]: "2026-07-30T11:59:59.000Z" }, createdAt: "2026-07-20T00:00:00.000Z" },
          { id: "4", name: "config-foreign", labels: {}, createdAt: "2026-07-20T00:00:00.000Z" },
        ],
        secrets: [
          { id: "5", name: "secret-expired", labels, createdAt: "2026-07-20T00:00:00.000Z" },
          { id: "6", name: "secret-other-project", labels: { ...labels, "com.openship.swarm.project-id": "project-b" }, createdAt: "2026-07-20T00:00:00.000Z" },
        ],
      },
      protectedRefs: { configs: new Set(["config-kept"]), secrets: new Set() },
      now,
      graceMs: SWARM_MANAGED_RESOURCE_GRACE_MS,
    });
    expect(plan).toEqual({ configs: ["config-expired"], secrets: ["secret-expired"] });
  });

  it("summarizes a daily sweep while isolating one unreachable manager", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const summary = await runSwarmManagedResourceGcSweep({
        listManaged: async () => [{ id: "stack-a" }, { id: "stack-b" }] as never,
        reap: async ({ stack }) => {
          if (stack.id === "stack-b") throw new Error("manager unavailable");
          return { configs: ["old-config"], secrets: ["old-secret"] };
        },
      });
      expect(summary).toEqual({ stacksScanned: 2, configsRemoved: 1, secretsRemoved: 1, errors: 1 });
      expect(error).toHaveBeenCalledWith(expect.stringContaining("stack-b skipped:"), expect.any(Error));
    } finally {
      error.mockRestore();
    }
  });
});
