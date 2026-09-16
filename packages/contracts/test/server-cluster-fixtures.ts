import { INFRASTRUCTURE_PROVIDERS } from "@repo/core";
import type {
  ClusterCapabilities,
  CreateClusterInput,
  ServerCluster,
} from "../src/server-clusters";

export function clusterInputFixture(): CreateClusterInput {
  return {
    requestId: "request-1234567890",
    name: "Production",
    network: { mode: "native", cidrs: ["10.20.0.0/24"], mtu: 1400, probePort: 51821 },
    members: [
      { serverId: "server-a", providerId: "hetzner-dedicated", privateIp: "10.20.0.2" },
      { serverId: "server-b", providerId: "custom", privateIp: "10.20.0.3" },
    ],
  };
}
export function serverClusterFixture(): ServerCluster {
  const input = clusterInputFixture();
  return {
    id: "cluster-a",
    name: input.name,
    location: null,
    revision: 1,
    network: { ...input.network, id: "network-a", ownership: "external", encryption: "external" },
    members: input.members.map((member) => ({ ...member, name: member.serverId })),
    verification: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}
export function clusterCapabilitiesFixture(): ClusterCapabilities {
  return {
    available: true,
    canManage: true,
    reason: null,
    maxMembers: 16,
    modes: ["native"],
    providers: INFRASTRUCTURE_PROVIDERS.map((p) => ({
      ...p,
      capabilities: { adopt: true, provision: false, configureHost: false },
    })),
  };
}
