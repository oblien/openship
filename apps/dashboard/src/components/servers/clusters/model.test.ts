import { describe, expect, it } from "vitest";
import { NETWORK_CHECK_TTL_MS } from "@repo/core";
import { serverClusterFixture } from "../../../../../../packages/contracts/test/server-cluster-fixtures";
import { clusterStatus } from "./model";

const now = Date.parse("2026-09-16T10:00:00Z");
function verifiedCluster() {
  const cluster = serverClusterFixture();
  cluster.verification = {
    id: "run-a",
    clusterId: cluster.id,
    revision: cluster.revision,
    status: "succeeded",
    report: { stage: "complete", hosts: [], peers: [] },
    error: null,
    startedAt: new Date(now - 30_000).toISOString(),
    finishedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 240_000).toISOString(),
  };
  return cluster;
}

describe("cluster verification presentation", () => {
  it("ages successful observations and never carries them across configuration revisions", () => {
    const cluster = verifiedCluster();
    expect(clusterStatus(cluster, now)).toBe("verified");
    expect(clusterStatus(cluster, now + NETWORK_CHECK_TTL_MS)).toBe("stale");
    cluster.revision += 1;
    expect(clusterStatus(cluster, now)).toBe("unchecked");
  });
  it("marks a stopped worker as interrupted without waiting for a controller response", () => {
    const cluster = verifiedCluster();
    cluster.verification!.status = "running";
    cluster.verification!.finishedAt = null;
    expect(clusterStatus(cluster, now)).toBe("checking");
    expect(clusterStatus(cluster, now + 240_000)).toBe("interrupted");
  });
  it("shows a failed check as needing attention even after an older success", () => {
    const cluster = verifiedCluster();
    cluster.verification!.status = "failed";
    expect(clusterStatus(cluster, now)).toBe("attention");
  });
});
