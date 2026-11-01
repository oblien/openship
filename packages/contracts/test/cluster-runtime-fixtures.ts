import { clusterRuntimeSteps, type ClusterRuntime, type ClusterRuntimePlan } from "@repo/core";

export function clusterRuntimePlanFixture(): ClusterRuntimePlan {
  return {
    networkId: "network-a",
    networkRevision: 1,
    version: "v1.36.4+k3s1",
    podCidr: "10.42.0.0/16",
    serviceCidr: "10.43.0.0/16",
    hosts: ["a", "b", "c"].map((id, index) => ({
      serverId: id,
      name: `Server ${id}`,
      address: `203.0.113.${index + 1}`,
      privateIp: `10.20.0.${index + 1}`,
      nodeName: `opsh-${id}`,
      role: "server",
      hostIdentity: `machine-${id}`,
      interfaceName: "wg0",
      installed: false,
      ready: false,
      steps: clusterRuntimeSteps(),
      logs: [],
    })),
  };
}
export function clusterRuntimeFixture(): ClusterRuntime {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    clusterId: "pool-a",
    provider: "k3s",
    status: "setting_up",
    intent: "setup",
    sequence: 1,
    generation: 1,
    plan: clusterRuntimePlanFixture(),
    error: null,
    verifiedAt: null,
    createdAt: "2026-09-21T12:00:00.000Z",
    updatedAt: "2026-09-21T12:00:00.000Z",
  };
}
