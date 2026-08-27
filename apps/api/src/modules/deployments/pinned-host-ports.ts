import {
  HostPortClaimConflictError,
  HOST_PORT_QUARANTINE_OWNER,
  repos,
  type HostPortClaim,
  type HostPortTargetKey,
} from "@repo/db";
import type { AllocateHostPortOptions, EdgeProxyApi, HostPortAllocation } from "@repo/adapters";
import type { HostPortTargetIdentity } from "../../lib/host-port-target";
import { createProvisionLock } from "../../lib/provision-lock";

/** The allocation helpers need only the stable ownership fields from a claim. */
export type PinnedHostPort = Pick<
  HostPortClaim,
  "projectId" | "serviceId" | "containerPort" | "port"
>;

export interface PinnedHostPortOwner {
  projectId: string;
  serviceId: string | null;
  containerPort: number | null;
}

export interface ReusablePinnedHostPort extends PinnedHostPortOwner {
  port: number;
}

/** One authoritative loopback publish that should remain claimed after reconciliation. */
export interface DesiredHostPortPublish {
  serviceId: string | null;
  containerPort: number;
  hostPort: number;
}

export interface ConvergeTargetHostPortClaimsInput {
  target: HostPortTargetIdentity;
  projectId: string;
  desiredPublishes: Iterable<DesiredHostPortPublish>;
  edgeProxy: Pick<EdgeProxyApi, "listLoopbackUpstreamPortsStrict">;
}

export interface ConvergeTargetHostPortClaimsResult {
  /** Exact workload/quarantine rows removed across canonical and legacy keys. */
  released: number;
  /** This project's rows still protected by a desired or observed edge route. */
  retained: HostPortClaim[];
}

/**
 * Serialize allocation through Docker bind + persistence for one physical
 * target. The in-process + Postgres lock prevents two API replicas from both
 * observing the same free port before either container starts listening.
 */
export function withHostPortTargetLock<T>(
  target: HostPortTargetIdentity,
  fn: () => Promise<T>,
): Promise<T> {
  return createProvisionLock(`host-port:${target.targetKey}`).run(fn);
}

function targetKeys(target: HostPortTargetIdentity): HostPortTargetKey[] {
  return [...new Set([target.targetKey, ...target.legacyTargetKeys])];
}

function assertStableTarget(target: HostPortTargetIdentity): void {
  if (target.stable) return;
  throw new Error(
    "Cannot safely reserve loopback ports because this target has no stable host identity. " +
      "Make /etc/machine-id readable or allow Openship to create /var/lib/openship/host-id.",
  );
}

async function listClaimsByKey(targetKey: HostPortTargetKey): Promise<HostPortClaim[]> {
  return repos.hostPortClaim.listHostPortClaims(targetKey);
}

/**
 * Durable port claims for the exact host this deploy targets.
 *
 * Deliberately does not catch database failures: continuing with an incomplete
 * set can steal a stopped container's port, which is worse than failing this
 * deploy before it mutates the host. Live socket scanning remains the second,
 * complementary half of allocation.
 */
export async function listTargetPinnedHostPorts(
  target: HostPortTargetIdentity,
): Promise<HostPortClaim[]> {
  const [canonicalClaims, ...legacyClaimSets] = await Promise.all(
    targetKeys(target).map(listClaimsByKey),
  );
  const canonicalPorts = new Set(canonicalClaims.map((claim) => claim.port));
  // A canonical row naturally supersedes every server-row alias on that port.
  // Until then, aliases remain part of allocation so stopped legacy workloads
  // keep their reservation after upgrading.
  return [
    ...canonicalClaims,
    ...legacyClaimSets.flat().filter((claim) => !canonicalPorts.has(claim.port)),
  ];
}

/**
 * Commit ownership before Docker is allowed to bind. The database unique index
 * is the final arbiter even if an allocator is accidentally called outside the
 * target lock.
 */
export function reserveTargetPinnedHostPort(
  target: HostPortTargetIdentity,
  claim: ReusablePinnedHostPort,
): Promise<HostPortClaim> {
  assertStableTarget(target);
  return repos.hostPortClaim.reserveHostPortClaim({
    targetKey: target.targetKey,
    ...claim,
  });
}

/**
 * Read the target's own edge before allocation and quarantine every loopback
 * upstream which has no canonical claim.
 *
 * Legacy aliases deliberately do not suppress quarantine: duplicate server
 * rows can carry contradictory backfilled owners for one physical port. The
 * canonical sentinel forces the first post-upgrade deploy off that ambiguous
 * port. The strict edge API rejects an inconclusive scan, so an unreadable edge
 * can never be mistaken for an empty one.
 *
 * The caller must hold {@link withHostPortTargetLock}; quarantine is kept until
 * a future route-aware reconciliation can prove the vhost is gone.
 */
export async function prepareTargetPinnedHostPorts(input: {
  target: HostPortTargetIdentity;
  edgeProxy: Pick<EdgeProxyApi, "listLoopbackUpstreamPortsStrict">;
}): Promise<HostPortClaim[]> {
  assertStableTarget(input.target);
  const observedPorts = await input.edgeProxy.listLoopbackUpstreamPortsStrict();
  const canonicalClaims = await listClaimsByKey(input.target.targetKey);
  const canonicalPorts = new Set(canonicalClaims.map((claim) => claim.port));

  for (const port of observedPorts) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || canonicalPorts.has(port)) {
      continue;
    }
    try {
      await repos.hostPortClaim.reserveQuarantinedHostPortClaim({
        targetKey: input.target.targetKey,
        port,
      });
      canonicalPorts.add(port);
    } catch (error) {
      // A caller outside the target lock may have legitimately won the unique
      // port race. Its canonical claim protects the port just as well; owner
      // conflicts or database failures remain fatal.
      if (!(error instanceof HostPortClaimConflictError) || error.conflict !== "port") {
        throw error;
      }
      canonicalPorts.add(port);
    }
  }

  return listTargetPinnedHostPorts(input.target);
}

function assertValidPort(value: number, field: "containerPort" | "hostPort"): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new RangeError(`${field} must be an integer between 1 and 65535`);
  }
}

function normalizeDesiredPublishes(
  projectId: string,
  publishes: Iterable<DesiredHostPortPublish>,
): DesiredHostPortPublish[] {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw new TypeError("projectId must not be empty");
  }
  if (projectId === HOST_PORT_QUARANTINE_OWNER) {
    throw new TypeError("The host-port quarantine owner is reserved for internal use");
  }

  const normalized: DesiredHostPortPublish[] = [];
  const hostPortOwners = new Map<number, string>();
  const ownerPorts = new Map<string, number>();
  for (const publish of publishes) {
    if (!publish || typeof publish !== "object") {
      throw new TypeError("desiredPublishes must contain valid loopback publishes");
    }
    if (
      publish.serviceId !== null &&
      (typeof publish.serviceId !== "string" || !publish.serviceId.trim())
    ) {
      throw new TypeError("serviceId must be null or a non-empty id");
    }
    if (publish.serviceId === HOST_PORT_QUARANTINE_OWNER) {
      throw new TypeError("The host-port quarantine owner is reserved for internal use");
    }
    assertValidPort(publish.containerPort, "containerPort");
    assertValidPort(publish.hostPort, "hostPort");

    const owner = JSON.stringify([publish.serviceId, publish.containerPort]);
    const existingOwner = hostPortOwners.get(publish.hostPort);
    if (existingOwner !== undefined && existingOwner !== owner) {
      throw new TypeError("desiredPublishes assigns one host port to multiple owners");
    }
    const existingPort = ownerPorts.get(owner);
    if (existingPort !== undefined && existingPort !== publish.hostPort) {
      throw new TypeError("desiredPublishes assigns one owner to multiple host ports");
    }
    if (existingPort === publish.hostPort) continue;

    hostPortOwners.set(publish.hostPort, owner);
    ownerPorts.set(owner, publish.hostPort);
    normalized.push(publish);
  }
  return normalized;
}

function exactDesiredClaim(
  claim: HostPortClaim,
  projectId: string,
  desired: DesiredHostPortPublish,
): boolean {
  return (
    claim.projectId === projectId &&
    claim.serviceId === desired.serviceId &&
    claim.containerPort === desired.containerPort &&
    claim.port === desired.hostPort
  );
}

function exactQuarantineClaim(claim: HostPortClaim): boolean {
  return (
    claim.projectId === HOST_PORT_QUARANTINE_OWNER &&
    claim.serviceId === HOST_PORT_QUARANTINE_OWNER &&
    claim.containerPort === claim.port
  );
}

/**
 * Converge durable claims after route mutation while the caller already holds
 * {@link withHostPortTargetLock}.
 *
 * Desired mappings are reserved before any read or release. A forced fresh edge
 * scan then proves which old ports are still dialled. If that scan or any
 * database read fails, no claim is released. Other projects are never touched;
 * legacy aliases are removed only when this project's canonical desired claim
 * already protects the same physical port.
 */
export async function convergeTargetHostPortClaimsUnlocked(
  input: ConvergeTargetHostPortClaimsInput,
): Promise<ConvergeTargetHostPortClaimsResult> {
  assertStableTarget(input.target);
  const desiredPublishes = normalizeDesiredPublishes(input.projectId, input.desiredPublishes);

  for (const publish of desiredPublishes) {
    await reserveTargetPinnedHostPort(input.target, {
      projectId: input.projectId,
      serviceId: publish.serviceId,
      containerPort: publish.containerPort,
      port: publish.hostPort,
    });
  }

  // Convergence runs after route writes, so the allocation-time memoized scan is
  // not authoritative here. A failed refresh rejects and releases nothing.
  const observedPorts = await input.edgeProxy.listLoopbackUpstreamPortsStrict({ refresh: true });
  const knownTargetKeys = targetKeys(input.target);
  const claimSets = await Promise.all(knownTargetKeys.map(listClaimsByKey));
  const allClaims = claimSets.flat();
  const desiredByPort = new Map(desiredPublishes.map((publish) => [publish.hostPort, publish]));
  const desiredCanonicalPorts = new Set<number>();
  for (const publish of desiredPublishes) {
    if (
      !allClaims.some(
        (claim) =>
          claim.targetKey === input.target.targetKey &&
          exactDesiredClaim(claim, input.projectId, publish),
      )
    ) {
      throw new Error(
        `Desired host-port claim ${publish.hostPort} disappeared before convergence completed`,
      );
    }
    desiredCanonicalPorts.add(publish.hostPort);
  }

  const retained: HostPortClaim[] = [];
  const workloadReleases: Array<{ claim: HostPortClaim; targetKey: HostPortTargetKey }> = [];
  const quarantineReleases: Array<{ claim: HostPortClaim; targetKey: HostPortTargetKey }> = [];

  for (const claim of allClaims) {
    const claimTargetKey = knownTargetKeys.find((targetKey) => targetKey === claim.targetKey);
    if (!claimTargetKey) {
      throw new Error(`Host-port claim returned from an unexpected target: ${claim.targetKey}`);
    }
    if (isQuarantineClaim(claim)) {
      if (!exactQuarantineClaim(claim)) {
        throw new Error(`Malformed host-port quarantine claim on ${claim.targetKey}`);
      }
      // A desired canonical workload row, reserved above, supersedes a legacy
      // quarantine alias even while the new route dials that same physical port.
      if (observedPorts.has(claim.port) && !desiredCanonicalPorts.has(claim.port)) continue;
      quarantineReleases.push({ claim, targetKey: claimTargetKey });
      continue;
    }

    if (claim.projectId !== input.projectId) continue;
    const desired = desiredByPort.get(claim.port);
    const isCanonicalDesired =
      claim.targetKey === input.target.targetKey &&
      desired !== undefined &&
      exactDesiredClaim(claim, input.projectId, desired);
    if (isCanonicalDesired || (observedPorts.has(claim.port) && !desired)) {
      retained.push(claim);
      continue;
    }
    // An observed row reaches here only when it is a legacy alias superseded by
    // the verified canonical desired row. An unobserved row needs no replacement.
    workloadReleases.push({ claim, targetKey: claimTargetKey });
  }

  let released = 0;
  for (const { claim, targetKey } of workloadReleases) {
    if (
      await repos.hostPortClaim.releaseHostPortClaim({
        targetKey,
        port: claim.port,
        projectId: claim.projectId,
        serviceId: claim.serviceId,
        containerPort: claim.containerPort,
      })
    ) {
      released += 1;
    }
  }
  for (const { claim, targetKey } of quarantineReleases) {
    if (
      await repos.hostPortClaim.releaseQuarantinedHostPortClaim({
        targetKey,
        port: claim.port,
      })
    ) {
      released += 1;
    }
  }

  return { released, retained };
}

/** Acquire the physical-target lock and safely converge this project's claims. */
export function convergeTargetHostPortClaims(
  input: ConvergeTargetHostPortClaimsInput,
): Promise<ConvergeTargetHostPortClaimsResult> {
  return withHostPortTargetLock(input.target, () => convergeTargetHostPortClaimsUnlocked(input));
}

/**
 * Find this workload's reservation on the target. Exact per-container claims
 * win; a null-container legacy scalar is accepted only as a migration fallback.
 */
export function findOwnedPinnedHostPort(
  claims: readonly PinnedHostPort[],
  owner: PinnedHostPortOwner,
  opts?: { allowLegacyContainerPort?: boolean },
): PinnedHostPort | undefined {
  const sameService = (claim: PinnedHostPort) =>
    !isQuarantineClaim(claim) &&
    claim.projectId === owner.projectId &&
    claim.serviceId === owner.serviceId;
  return (
    claims.find((claim) => sameService(claim) && claim.containerPort === owner.containerPort) ??
    (opts?.allowLegacyContainerPort
      ? claims.find((claim) => sameService(claim) && claim.containerPort === null)
      : undefined)
  );
}

export interface AllocateAndReservePinnedHostPortInput {
  target: HostPortTargetIdentity;
  claims: readonly PinnedHostPort[];
  owner: PinnedHostPortOwner;
  /** Compatibility cache only; a reservation on this target always wins. */
  cachedPreferred?: number | null;
  allowLegacyContainerPort?: boolean;
  additionalAvoid?: Iterable<number>;
  allocate: (options: AllocateHostPortOptions) => Promise<HostPortAllocation>;
}

export interface AllocatedPinnedHostPort extends HostPortAllocation {
  preferred?: number;
  previousClaim?: PinnedHostPort;
  claim: HostPortClaim;
}

/**
 * Roll back reservations created by an activation attempt that never wrote a
 * route. Carried claims are never touched: an older vhost or stopped workload
 * may still depend on them. Callers must invoke this only while holding the
 * target lock and only before any route for the attempted workload was written.
 */
export async function releaseNewPinnedHostPortClaims(
  target: HostPortTargetIdentity,
  allocations: Iterable<Pick<AllocatedPinnedHostPort, "claim" | "previousClaim">>,
): Promise<number> {
  let released = 0;
  for (const allocation of allocations) {
    if (allocation.previousClaim) continue;
    const claim = allocation.claim;
    if (claim.targetKey !== target.targetKey) {
      throw new Error("Cannot release a host-port claim from another physical target");
    }
    if (
      await repos.hostPortClaim.releaseHostPortClaim({
        targetKey: claim.targetKey,
        port: claim.port,
        projectId: claim.projectId,
        serviceId: claim.serviceId,
        containerPort: claim.containerPort,
      })
    ) {
      released += 1;
    }
  }
  return released;
}

/**
 * The single allocation seam for routed host ports.
 *
 * Callers hold {@link withHostPortTargetLock} around this call through the
 * workload bind. Within that section we combine durable claims with live socket
 * occupancy and then reserve the selected number before returning it to Docker.
 */
export async function allocateAndReservePinnedHostPort(
  input: AllocateAndReservePinnedHostPortInput,
): Promise<AllocatedPinnedHostPort> {
  const previousClaim = findOwnedPinnedHostPort(input.claims, input.owner, {
    allowLegacyContainerPort: input.allowLegacyContainerPort,
  });
  const preferred = previousClaim?.port ?? input.cachedPreferred ?? undefined;
  const reusable = previousClaim
    ? {
        ...input.owner,
        containerPort: previousClaim.containerPort,
        port: previousClaim.port,
      }
    : undefined;
  const avoid = pinnedHostPortsToAvoid(input.claims, reusable);
  for (const port of input.additionalAvoid ?? []) avoid.add(port);

  const allocation = await input.allocate({
    preferred,
    avoid,
    reuseOccupiedPreferred: reusable
      ? ownsReusablePinnedHostPort(input.claims, reusable) && !avoid.has(reusable.port)
      : false,
  });
  const claim = await reserveTargetPinnedHostPort(input.target, {
    ...input.owner,
    // `null` is a real legacy identity, not a missing value. Preserve it until
    // route-aware cleanup can upgrade/release the row without a reservation gap.
    containerPort: previousClaim ? previousClaim.containerPort : input.owner.containerPort,
    port: allocation.port,
  });
  return { ...allocation, preferred, previousClaim, claim };
}

/**
 * Convert owned claims into an allocator avoid-set, optionally releasing the
 * caller's own carried claim. A number is released only when no other owner
 * claims it, so corrupt/legacy duplicate rows fail safe instead of letting one
 * service erase a sibling's reservation.
 */
export function pinnedHostPortsToAvoid(
  claims: readonly PinnedHostPort[],
  reusable?: ReusablePinnedHostPort,
): Set<number> {
  const avoid = new Set(claims.map((claim) => claim.port));
  if (!reusable) return avoid;

  const ownsClaim = ownsReusablePinnedHostPort(claims, reusable);
  const anotherOwnerClaimsIt = claims.some(
    (claim) =>
      claim.port === reusable.port &&
      (claim.projectId !== reusable.projectId ||
        claim.serviceId !== reusable.serviceId ||
        (claim.containerPort !== null && claim.containerPort !== reusable.containerPort)),
  );
  if (ownsClaim && !anotherOwnerClaimsIt) avoid.delete(reusable.port);
  return avoid;
}

/** Whether the exact workload/port owns this pin on the target being queried. */
export function ownsReusablePinnedHostPort(
  claims: readonly PinnedHostPort[],
  reusable: ReusablePinnedHostPort,
): boolean {
  return claims.some(
    (claim) =>
      !isQuarantineClaim(claim) &&
      claim.projectId === reusable.projectId &&
      claim.serviceId === reusable.serviceId &&
      (claim.containerPort === null || claim.containerPort === reusable.containerPort) &&
      claim.port === reusable.port,
  );
}

/** Quarantine can never become a reusable workload claim, even after import. */
export function isQuarantineClaim(claim: Pick<PinnedHostPort, "projectId" | "serviceId">): boolean {
  return (
    claim.projectId === HOST_PORT_QUARANTINE_OWNER || claim.serviceId === HOST_PORT_QUARANTINE_OWNER
  );
}
