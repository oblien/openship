/** Pure policy for attaching explicitly exposed Swarm services to OpenShip Edge. */

import { AppError } from "@repo/core";
import { SWARM_EDGE_NETWORK_NAME } from "@repo/adapters";
import type { Service, SwarmStack } from "@repo/db";

export interface SwarmEdgeAttachmentPlan {
  networkAttachments: Record<string, { networkName: string; aliases: string[] }>;
  externalNetworks: Record<string, string>;
  upstreams: Array<{ sourceServiceName: string; serviceDnsName: string; port: number }>;
}

function exposedPort(service: Service): number {
  const raw = service.exposedPort?.trim() ?? "";
  if (!/^\d+$/.test(raw)) {
    throw new AppError(
      `OpenShip Edge requires an explicit container port for exposed service ${service.name}.`,
      409,
      "SWARM_EDGE_PORT_REQUIRED",
    );
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AppError(
      `OpenShip Edge port for service ${service.name} must be from 1 to 65535.`,
      409,
      "SWARM_EDGE_PORT_INVALID",
    );
  }
  return port;
}

function serviceDnsName(stackName: string, sourceServiceName: string): string {
  // Docker composes its service name from these two user-controlled identifiers.
  // Keep the generated DNS target constrained to that exact scheduler identity,
  // never a generic URL or an arbitrary nginx directive.
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(stackName) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sourceServiceName)) {
    throw new AppError("A source service name is unsafe for OpenShip Edge routing.", 409, "SWARM_EDGE_SERVICE_NAME_INVALID");
  }
  return `${stackName}_${sourceServiceName}`;
}

/**
 * Only rows an operator has marked exposed receive the cross-stack overlay.
 * The generated alias is stable and unique per stack, so two projects can use
 * a `web` service without the Edge resolving an ambiguous short alias.
 */
export function planSwarmEdgeAttachments(
  stack: Pick<SwarmStack, "routingMode" | "stackName">,
  sourceServiceNames: string[],
  rows: Service[],
): SwarmEdgeAttachmentPlan | null {
  if (stack.routingMode !== "openship-edge") return null;
  const bySource = new Map(rows.filter((row) => row.sourceServiceName).map((row) => [row.sourceServiceName!, row]));
  const networkAttachments: SwarmEdgeAttachmentPlan["networkAttachments"] = {};
  const upstreams: SwarmEdgeAttachmentPlan["upstreams"] = [];
  for (const sourceServiceName of sourceServiceNames.slice().sort((a, b) => a.localeCompare(b))) {
    const service = bySource.get(sourceServiceName);
    if (!service?.enabled || !service.exposed) continue;
    const dnsName = serviceDnsName(stack.stackName, sourceServiceName);
    networkAttachments[sourceServiceName] = { networkName: SWARM_EDGE_NETWORK_NAME, aliases: [dnsName] };
    upstreams.push({ sourceServiceName, serviceDnsName: dnsName, port: exposedPort(service) });
  }
  return {
    networkAttachments,
    externalNetworks: Object.keys(networkAttachments).length ? { [SWARM_EDGE_NETWORK_NAME]: SWARM_EDGE_NETWORK_NAME } : {},
    upstreams,
  };
}
