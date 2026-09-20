import { validWireGuardEndpoint } from "./managed-network";
import { isInfrastructurePrivateIp } from "./infrastructure";
import { networkTransportPeers, type NetworkAccessPolicy } from "./network-access";

export type NetworkFirewallScope =
  | { mode: "wireguard"; access?: NetworkAccessPolicy }
  | { mode: "native"; probePort: number };

export interface NetworkFirewallMember {
  serverId: string;
  endpoint?: string;
  listenPort?: number;
  privateIp?: string;
  interfaceName?: string;
}

export interface NetworkFirewallRule {
  serverId: string;
  peerServerId: string;
  direction: "inbound" | "outbound";
  action: "allow";
  protocol: "tcp" | "udp";
  source: string;
  /** An unrestricted source port also permits translated UDP source ports. */
  sourcePort: "any" | number;
  destination: string;
  destinationPort: number | "any";
  interfaceName?: string;
  reply?: true;
}

function endpoint(member: NetworkFirewallMember, scope: NetworkFirewallScope) {
  const address = scope.mode === "native" ? member.privateIp : member.endpoint;
  const port = scope.mode === "native" ? scope.probePort : member.listenPort;
  const validAddress =
    typeof address === "string" &&
    (scope.mode === "native"
      ? isInfrastructurePrivateIp(address)
      : validWireGuardEndpoint(address));
  if (
    !validAddress ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    return null;
  return { address, port };
}

/** WireGuard transport or native private verification rules, scoped to individual peers. */
export function networkFirewallRules(
  members: NetworkFirewallMember[],
  serverId: string,
  scope: NetworkFirewallScope = { mode: "wireguard" },
): { rules: NetworkFirewallRule[]; pendingServerIds: string[] } {
  const server = members.find((member) => member.serverId === serverId);
  const peers =
    scope.mode === "wireguard"
      ? networkTransportPeers(members, serverId, scope.access)
      : members.filter((member) => member.serverId !== serverId);
  const addresses = new Map(members.map((member) => [member.serverId, endpoint(member, scope)]));
  const pendingServerIds = (
    peers.length
      ? members.filter(
          (member) =>
            member.serverId === serverId || peers.some((peer) => peer.serverId === member.serverId),
        )
      : []
  )
    .filter((member) => !addresses.get(member.serverId))
    .map((member) => member.serverId);
  if (!server) pendingServerIds.push(serverId);
  const rules: NetworkFirewallRule[] = [];
  const local = addresses.get(serverId);
  if (server && local) {
    for (const peer of peers) {
      const remote = addresses.get(peer.serverId);
      if (peer.serverId === serverId || !remote) continue;
      const common = {
        serverId,
        peerServerId: peer.serverId,
        action: "allow",
        sourcePort: "any",
        ...(scope.mode === "native" && server.interfaceName
          ? { interfaceName: server.interfaceName }
          : {}),
      } as const;
      for (const protocol of scope.mode === "native"
        ? (["tcp", "udp"] as const)
        : (["udp"] as const)) {
        rules.push(
          {
            ...common,
            protocol,
            direction: "inbound",
            source: `${remote.address}/32`,
            destination: `${local.address}/32`,
            destinationPort: local.port,
          },
          {
            ...common,
            protocol,
            direction: "outbound",
            source: `${local.address}/32`,
            destination: `${remote.address}/32`,
            destinationPort: remote.port,
          },
        );
        // Native probes originate from an ephemeral client port. Stateless ACLs
        // also need the reverse path, scoped to the same private peer addresses.
        if (scope.mode === "native")
          rules.push(
            {
              ...common,
              protocol,
              direction: "inbound",
              reply: true,
              source: `${remote.address}/32`,
              sourcePort: remote.port,
              destination: `${local.address}/32`,
              destinationPort: "any",
            },
            {
              ...common,
              protocol,
              direction: "outbound",
              reply: true,
              source: `${local.address}/32`,
              sourcePort: local.port,
              destination: `${remote.address}/32`,
              destinationPort: "any",
            },
          );
      }
    }
  }
  return { rules, pendingServerIds };
}

/** TSV pastes into a spreadsheet or ticket without pretending to be a provider API payload. */
export function networkFirewallTemplate(
  members: NetworkFirewallMember[],
  serverId: string,
  scope: NetworkFirewallScope = { mode: "wireguard" },
): string | null {
  const { rules, pendingServerIds } = networkFirewallRules(members, serverId, scope);
  if (pendingServerIds.length || !rules.length) return null;
  return [
    "Direction\tAction\tProtocol\tSource CIDR\tSource port\tDestination CIDR\tDestination port" +
      (scope.mode === "native" ? "\tPrivate interface\tPurpose" : ""),
    ...rules.map((rule) =>
      [
        rule.direction,
        rule.action,
        rule.protocol,
        rule.source,
        rule.sourcePort,
        rule.destination,
        rule.destinationPort,
        ...(scope.mode === "native"
          ? [rule.interfaceName ?? "", rule.reply ? "reply" : "probe"]
          : []),
      ].join("\t"),
    ),
  ].join("\n");
}
