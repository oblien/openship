import { describe, expect, it, vi } from "vitest";
// Satisfy config/env.ts's eager boot guard; the autoscaler's own import of the
// same module resolves to this mock too (CLOUD_MODE stays false by default).
vi.mock("../src/engine/config/env", () => ({
  env: { REDIS_URL: "redis://unused.invalid", CLOUD_MODE: false, DEPLOY_MODE: "desktop" },
}));
import {
  decideReplicas,
  autoscaleEligibilityReason,
} from "../src/engine/modules/projects/autoscale/autoscaler";
import type { Project } from "@repo/db";

const policy = {
  targetCpuPercent: 70,
  minReplicas: 1,
  maxReplicas: 6,
  stepSize: 1,
};

describe("decideReplicas", () => {
  it("scales up one step when usage exceeds the target beyond hysteresis", () => {
    // 3 instances at 90% vs a 70% target: HPA formula wants ceil(3*90/70)=4.
    expect(decideReplicas(3, 90, policy)).toEqual({ direction: "scale_up", desired: 4 });
  });

  it("holds when usage sits inside the ±10% hysteresis band", () => {
    // 75% is inside 63..77: the loop must not oscillate around the target.
    expect(decideReplicas(3, 75, policy)).toBeNull();
    expect(decideReplicas(3, 60, policy)).toBeNull();
  });

  it("scales down one step when usage drops below the band", () => {
    expect(decideReplicas(3, 40, policy)).toEqual({ direction: "scale_down", desired: 2 });
  });

  it("never steps past the clamps in either direction", () => {
    // At max: a step would land on the same count → hold.
    expect(decideReplicas(6, 90, policy)).toBeNull();
    // At min: same.
    expect(decideReplicas(1, 10, policy)).toBeNull();
  });

  it("converges to edited bounds one step at a time, even inside the CPU band", () => {
    expect(decideReplicas(10, 70, policy)).toEqual({ direction: "scale_down", desired: 9 });
    expect(decideReplicas(1, 70, { ...policy, minReplicas: 3 })).toEqual({
      direction: "scale_up",
      desired: 2,
    });
  });

  it("moves at most one step per tick even under extreme load", () => {
    expect(decideReplicas(2, 500, policy)).toEqual({ direction: "scale_up", desired: 3 });
  });

  it("does not overshoot the CPU target with a larger stepSize", () => {
    expect(decideReplicas(2, 95, { ...policy, stepSize: 3 })).toEqual({
      direction: "scale_up",
      desired: 3,
    });
  });
});

describe("autoscaleEligibilityReason", () => {
  const meta = { clusterId: "cluster-1", clusterConfig: { replicas: 2 } } as never;

  const project = (overrides: Partial<Project>): Project =>
    ({
      id: "p",
      appTemplateId: null,
      clusterId: "cluster-1",
      framework: null,
      resources: { production: { cpuCores: 1, memoryMb: 512 }, build: {} },
      ...overrides,
    }) as unknown as Project;

  it("accepts a cluster-deployed web app with a CPU limit", () => {
    expect(autoscaleEligibilityReason(project({}), meta)).toBeNull();
  });

  it("refuses projects without a CPU limit: the denominator would not exist", () => {
    expect(
      autoscaleEligibilityReason(project({ resources: { production: { cpuCores: 0 } } }), meta),
    ).toContain("CPU limit");
  });

  it("refuses database projects: they replicate through database management", () => {
    expect(autoscaleEligibilityReason(project({ framework: "postgres" }), meta)).toContain(
      "database management",
    );
  });

  it("refuses the OpenShip control plane and non-cluster projects", () => {
    expect(autoscaleEligibilityReason(project({ appTemplateId: "openship" }), meta)).toContain(
      "control plane",
    );
    expect(autoscaleEligibilityReason(project({ clusterId: null }), meta)).toContain(
      "server cluster",
    );
  });

  it("refuses when the active release points at another cluster", () => {
    expect(
      autoscaleEligibilityReason(project({}), {
        ...meta,
        clusterId: "cluster-2",
      } as never),
    ).toContain("selected cluster");
  });
});
