import { ClusterConfigError, MAX_CLUSTER_MEMBERS } from "./infrastructure";

/** Initiation policy for traffic addressed to members of a managed private network. */
export interface NetworkAccessPolicy {
  version: 1;
  rules: NetworkAccessRule[];
}

export interface NetworkAccessRule {
  sourceServerId: string;
  targetServerId: string;
}

export type NetworkConnectionMode = "both" | "forward" | "reverse" | "blocked";

/** Omitted policies preserve existing full meshes; an empty rule list isolates every member. */
export function networkAccessAllowed(
  policy: NetworkAccessPolicy | undefined | null,
  source: string,
  target: string,
): boolean {
  return (
    source !== target &&
    (!policy ||
      policy.rules.some((rule) => rule.sourceServerId === source && rule.targetServerId === target))
  );
}

export function networkConnectionMode(
  policy: NetworkAccessPolicy | undefined | null,
  source: string,
  target: string,
): NetworkConnectionMode {
  const forward = networkAccessAllowed(policy, source, target);
  const reverse = networkAccessAllowed(policy, target, source);
  return forward ? (reverse ? "both" : "forward") : reverse ? "reverse" : "blocked";
}

/** WireGuard's encrypted transport is bidirectional even when only one side may initiate. */
export function networkTransportPeers<T extends { serverId: string }>(
  members: readonly T[],
  serverId: string,
  policy?: NetworkAccessPolicy | null,
): T[] {
  return members.filter(
    (peer) =>
      peer.serverId !== serverId &&
      networkConnectionMode(policy, serverId, peer.serverId) !== "blocked",
  );
}

export function normalizeNetworkAccess(
  policy: NetworkAccessPolicy,
  memberIds: readonly string[],
): NetworkAccessPolicy {
  if (
    !policy ||
    policy.version !== 1 ||
    !Array.isArray(policy.rules) ||
    policy.rules.length > MAX_CLUSTER_MEMBERS * (MAX_CLUSTER_MEMBERS - 1)
  )
    throw new ClusterConfigError("Invalid network connection policy.");
  const members = new Set(memberIds);
  const seen = new Set<string>();
  const rules = policy.rules.map((rule) => {
    if (
      !rule ||
      !members.has(rule.sourceServerId) ||
      !members.has(rule.targetServerId) ||
      rule.sourceServerId === rule.targetServerId
    )
      throw new ClusterConfigError(
        "Connections must reference two different servers in this network.",
      );
    const key = JSON.stringify([rule.sourceServerId, rule.targetServerId]);
    if (seen.has(key))
      throw new ClusterConfigError("A network connection direction is listed more than once.");
    seen.add(key);
    return { sourceServerId: rule.sourceServerId, targetServerId: rule.targetServerId };
  });
  rules.sort(
    (a, b) =>
      a.sourceServerId.localeCompare(b.sourceServerId) ||
      a.targetServerId.localeCompare(b.targetServerId),
  );
  return { version: 1, rules };
}

export function fullNetworkAccess(memberIds: readonly string[]): NetworkAccessPolicy {
  return normalizeNetworkAccess(
    {
      version: 1,
      rules: memberIds.flatMap((sourceServerId) =>
        memberIds
          .filter((id) => id !== sourceServerId)
          .map((targetServerId) => ({ sourceServerId, targetServerId })),
      ),
    },
    memberIds,
  );
}

export function setNetworkConnection(
  policy: NetworkAccessPolicy | undefined | null,
  memberIds: readonly string[],
  source: string,
  target: string,
  mode: NetworkConnectionMode,
): NetworkAccessPolicy {
  if (source === target || !memberIds.includes(source) || !memberIds.includes(target))
    throw new ClusterConfigError("Choose two different servers in this network.");
  const rules = (policy ?? fullNetworkAccess(memberIds)).rules.filter(
    (rule) =>
      !(rule.sourceServerId === source && rule.targetServerId === target) &&
      !(rule.sourceServerId === target && rule.targetServerId === source),
  );
  if (mode === "both" || mode === "forward")
    rules.push({ sourceServerId: source, targetServerId: target });
  if (mode === "both" || mode === "reverse")
    rules.push({ sourceServerId: target, targetServerId: source });
  return normalizeNetworkAccess({ version: 1, rules }, memberIds);
}

/** Removing a server must never reset the remaining members to a full mesh. */
export function retainNetworkAccess(
  policy: NetworkAccessPolicy | undefined | null,
  memberIds: readonly string[],
): NetworkAccessPolicy | undefined {
  if (!policy) return undefined;
  return normalizeNetworkAccess(
    {
      version: 1,
      rules: policy.rules.filter(
        (rule) =>
          memberIds.includes(rule.sourceServerId) && memberIds.includes(rule.targetServerId),
      ),
    },
    memberIds,
  );
}
