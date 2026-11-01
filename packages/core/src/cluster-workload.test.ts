import { describe, expect, it } from "vitest";
import { clusterWorkloadUnsupportedReason } from "./cluster-workload";

describe("workload replication eligibility", () => {
  it("allows independent applications and workers", () => {
    expect(clusterWorkloadUnsupportedReason({ workload: "web", framework: "express" })).toBeNull();
    expect(clusterWorkloadUnsupportedReason({ workload: "worker" })).toBeNull();
  });
  it("defers Swarm service and named-volume placement to its existing runtime policy", () => {
    expect(
      clusterWorkloadUnsupportedReason({
        workload: "web",
        provider: "swarm",
        services: [{}],
        volumes: ["data:/data"],
      }),
    ).toBeNull();
    expect(
      clusterWorkloadUnsupportedReason({ workload: "web", provider: "swarm", image: "redis:7" }),
    ).toContain("Database replication");
  });
  it.each([
    { workload: "static" },
    { workload: "web", services: [{}] },
    { workload: "web", volumes: ["data:/data"] },
    { workload: "web", framework: "postgres" },
    { workload: "web", image: "redis:7" },
  ])("keeps unsupported stateful or service workloads explicit: %j", (input) => {
    expect(clusterWorkloadUnsupportedReason(input)).toBeTruthy();
  });
});
