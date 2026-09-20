import {
  managedInterfaceName,
  type ManagedNetworkOperation,
  type ManagedNetworkPlan,
  type ClusterNetworkReport,
  managedNetworkSteps,
  MANAGED_NETWORK_PREPARATION_STEPS,
  type ManagedNetworkPreparation,
  type ManagedNetworkPreparationSummary,
} from "@repo/core";

export function managedPreparationFixture(ids?: string[]): ManagedNetworkPreparation {
  const input = managedPlanInputFixture();
  if (ids)
    input.members = managedPlanFixture(ids).config.members.map(
      ({ serverId, providerId, endpoint, listenPort }) => ({
        serverId,
        providerId,
        endpoint,
        listenPort,
      }),
    );
  return {
    id: input.requestId,
    sequence: 1,
    input,
    status: "preparing",
    operationId: null,
    replacementPreparationId: null,
    cleanupOperationId: null,
    error: null,
    generation: 1,
    leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hosts: input.members.map((member) => ({
      serverId: member.serverId,
      name: member.serverId,
      address: member.endpoint!,
      hostIdentity: null,
      steps: managedNetworkSteps(MANAGED_NETWORK_PREPARATION_STEPS),
      logs: [],
    })),
  };
}
export function managedPreparationSummaryFixture(): ManagedNetworkPreparationSummary {
  const value = managedPreparationFixture();
  return {
    id: value.id,
    sequence: value.sequence,
    name: value.input.name,
    status: value.status,
    serverCount: value.hosts.length,
    error: value.error,
    operationId: value.operationId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
import type { PlanManagedNetworkInput } from "../src/server-clusters";

export function managedPlanInputFixture(): PlanManagedNetworkInput {
  return {
    requestId: "aaaaaaaa-1111-4111-8111-111111111111",
    name: "Production mesh",
    members: [
      {
        serverId: "server-a",
        providerId: "hetzner-dedicated",
        endpoint: "192.0.2.10",
        listenPort: 51820,
      },
      { serverId: "server-b", providerId: "custom", endpoint: "192.0.2.11", listenPort: 51820 },
    ],
  };
}

export function managedPlanFixture(ids = ["server-a", "server-b"]): ManagedNetworkPlan {
  const managedId = "abcdef0123456789abcdef0123456789";
  const interfaceName = managedInterfaceName(managedId);
  return {
    version: 1,
    clusterId: "cluster-managed",
    managedId,
    interfaceName,
    baseRevision: null,
    intent: "configure",
    rotateKeys: false,
    config: {
      name: "Production mesh",
      network: {
        mode: "wireguard",
        managedId,
        interfaceName,
        cidrs: ["10.244.0.0/24"],
        mtu: 1400,
        probePort: 45876,
      },
      members: ids.map((id, index) => ({
        serverId: id,
        providerId: "custom",
        privateIp: `10.244.0.${index + 1}`,
        interfaceName,
        endpoint: `192.0.2.${index + 10}`,
        listenPort: 51820,
      })),
    },
    previous: null,
    hosts: ids.map((id, index) => ({
      serverId: id,
      name: id,
      hostIdentity: `host:${id}`,
      fingerprint: "a".repeat(64),
      configHash: null,
      endpoint: `192.0.2.${index + 10}`,
      listenPort: 51820,
      privateIp: `10.244.0.${index + 1}`,
      packages: ["wireguard-tools"],
      firewall: "iptables",
      action: "configure",
    })),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

export function managedOperationFixture(ids = ["server-a", "server-b"]): ManagedNetworkOperation {
  const plan = managedPlanFixture(ids);
  return {
    id: managedPlanInputFixture().requestId,
    sequence: 1,
    clusterId: plan.clusterId,
    status: "planned",
    planHash: "b".repeat(64),
    plan,
    replacementPreparationId: null,
    hosts: ids.map((serverId) => ({ serverId, stage: "pending", publicKey: null, error: null })),
    report: null,
    error: null,
    generation: 0,
    leaseExpiresAt: null,
    createdAt: plan.createdAt,
    updatedAt: plan.createdAt,
  };
}

export function successfulManagedReport(plan: ManagedNetworkPlan): ClusterNetworkReport {
  return {
    stage: "complete",
    hosts: plan.config.members.map((member) => ({
      serverId: member.serverId,
      ok: true,
      interfaceName: plan.interfaceName,
      mtu: plan.config.network.mtu,
      code: null,
      message: null,
    })),
    peers: plan.config.members.flatMap((source) =>
      plan.config.members
        .filter((target) => target.serverId !== source.serverId)
        .map((target) => ({
          sourceServerId: source.serverId,
          targetServerId: target.serverId,
          tcp: true,
          udp: true,
          mtu: true,
          latencyMs: 1,
          message: null,
        })),
    ),
  };
}
