import { and, asc, eq, isNull, not, or, type SQL } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { hostPortClaim } from "../schema/host-port-claim";

export type HostPortClaim = typeof hostPortClaim.$inferSelect;
export type NewHostPortClaim = typeof hostPortClaim.$inferInsert;
export type HostPortTargetKey = "local" | `host:${string}` | `server:${string}`;
/** Impossible workload owner used to fail closed around ambiguous/orphan routes. */
export const HOST_PORT_QUARANTINE_OWNER = "__host_port_quarantine__";

export interface HostPortClaimIdentity {
  targetKey: HostPortTargetKey;
  port: number;
  projectId: string;
  serviceId: string | null;
  containerPort: number | null;
}

export interface HostPortClaimOwner {
  targetKey: HostPortTargetKey;
  projectId: string;
  serviceId: string | null;
}

export interface PruneHostPortClaimsInput extends HostPortClaimOwner {
  keep: ReadonlyArray<Pick<HostPortClaimIdentity, "port" | "containerPort">>;
}

/**
 * A reservation can conflict in either direction:
 *
 * - `port`: another stable owner already reserves this target/port;
 * - `owner`: this owner already reserves a different port on this target.
 *
 * Existing owner details are deliberately not included in the message. The
 * repository is host-global, and a caller must not turn a collision into a
 * cross-organization project/service oracle.
 */
export class HostPortClaimConflictError extends Error {
  readonly code = "HOST_PORT_CLAIM_CONFLICT" as const;

  constructor(
    public readonly conflict: "port" | "owner",
    public readonly targetKey: HostPortTargetKey,
    public readonly port: number,
  ) {
    super(
      conflict === "port"
        ? `Host port ${port} is already reserved on ${targetKey}`
        : `This workload already reserves another host port on ${targetKey}`,
    );
    this.name = "HostPortClaimConflictError";
  }
}

function assertTargetKey(value: string): asserts value is HostPortTargetKey {
  if (value === "local") return;
  if (/^host:[0-9a-f]{64}$/.test(value)) return;
  if (value.startsWith("server:") && value.length > "server:".length) return;
  throw new TypeError(
    'targetKey must be "local", "host:<sha256>", or the legacy alias "server:<id>"',
  );
}

function assertPort(value: number, field: "port" | "containerPort"): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new RangeError(`${field} must be an integer between 1 and 65535`);
  }
}

function assertOwner(owner: {
  projectId: string;
  serviceId: string | null;
  containerPort?: number | null;
}): void {
  if (!owner.projectId.trim()) throw new TypeError("projectId must not be empty");
  if (owner.serviceId !== null && !owner.serviceId.trim()) {
    throw new TypeError("serviceId must be null or a non-empty id");
  }
  if (owner.containerPort != null) assertPort(owner.containerPort, "containerPort");
}

function assertWorkloadOwner(owner: { projectId: string; serviceId: string | null }): void {
  if (
    owner.projectId === HOST_PORT_QUARANTINE_OWNER ||
    owner.serviceId === HOST_PORT_QUARANTINE_OWNER
  ) {
    throw new TypeError("The host-port quarantine owner is reserved for internal use");
  }
}

function validateIdentity(input: HostPortClaimIdentity): void {
  assertTargetKey(input.targetKey);
  assertPort(input.port, "port");
  assertOwner(input);
}

function nullableServiceCondition(serviceId: string | null): SQL {
  return serviceId === null
    ? isNull(hostPortClaim.serviceId)
    : eq(hostPortClaim.serviceId, serviceId);
}

function nullableContainerPortCondition(containerPort: number | null): SQL {
  return containerPort === null
    ? isNull(hostPortClaim.containerPort)
    : eq(hostPortClaim.containerPort, containerPort);
}

function sameOwner(
  claim: HostPortClaim,
  identity: Pick<HostPortClaimIdentity, "projectId" | "serviceId" | "containerPort">,
): boolean {
  return (
    claim.projectId === identity.projectId &&
    claim.serviceId === identity.serviceId &&
    claim.containerPort === identity.containerPort
  );
}

function ownerScope(owner: HostPortClaimOwner): SQL {
  return and(
    eq(hostPortClaim.targetKey, owner.targetKey),
    eq(hostPortClaim.projectId, owner.projectId),
    nullableServiceCondition(owner.serviceId),
  )!;
}

export function createHostPortClaimRepo(db: Database) {
  const reserveIdentity = async (input: HostPortClaimIdentity): Promise<HostPortClaim> => {
    // A concurrent exact release can land between ON CONFLICT and the lookup.
    // Retry that narrow disappearing-row race; ordinary conflicts throw on the
    // first pass and never spin.
    for (let attempt = 0; attempt < 3; attempt++) {
      const [inserted] = await db
        .insert(hostPortClaim)
        .values({ id: generateId("hpc"), ...input })
        .onConflictDoNothing()
        .returning();
      if (inserted) return inserted;

      const [byPort] = await db
        .select()
        .from(hostPortClaim)
        .where(
          and(eq(hostPortClaim.targetKey, input.targetKey), eq(hostPortClaim.port, input.port)),
        )
        .limit(1);
      if (byPort) {
        if (sameOwner(byPort, input)) return byPort;
        // Backfilled scalar claims know the project/service and physical port,
        // but not the container port. The first live route observation can
        // safely refine that SAME row. Updating in place preserves continuous
        // ownership of the host port; delete+insert would open a theft window.
        if (
          byPort.projectId === input.projectId &&
          byPort.serviceId === input.serviceId &&
          byPort.containerPort === null &&
          input.containerPort !== null
        ) {
          const [existingExactOwner] = await db
            .select()
            .from(hostPortClaim)
            .where(
              and(
                eq(hostPortClaim.targetKey, input.targetKey),
                eq(hostPortClaim.projectId, input.projectId),
                nullableServiceCondition(input.serviceId),
                eq(hostPortClaim.containerPort, input.containerPort),
              ),
            )
            .limit(1);
          if (existingExactOwner) {
            throw new HostPortClaimConflictError("owner", input.targetKey, input.port);
          }

          try {
            const [upgraded] = await db
              .update(hostPortClaim)
              .set({ containerPort: input.containerPort, updatedAt: new Date() })
              .where(and(eq(hostPortClaim.id, byPort.id), isNull(hostPortClaim.containerPort)))
              .returning();
            if (upgraded) return upgraded;
          } catch (error) {
            // A concurrent exact-owner insert can win after the read above. Map
            // that unique collision to the repository's stable, non-leaky error;
            // preserve unrelated database failures verbatim.
            const [concurrentExactOwner] = await db
              .select()
              .from(hostPortClaim)
              .where(
                and(
                  eq(hostPortClaim.targetKey, input.targetKey),
                  eq(hostPortClaim.projectId, input.projectId),
                  nullableServiceCondition(input.serviceId),
                  eq(hostPortClaim.containerPort, input.containerPort),
                ),
              )
              .limit(1);
            if (concurrentExactOwner) {
              throw new HostPortClaimConflictError("owner", input.targetKey, input.port);
            }
            throw error;
          }

          // Another observer changed or released the legacy row. Retry from a
          // fresh insert/read rather than deciding from stale state.
          continue;
        }
        throw new HostPortClaimConflictError("port", input.targetKey, input.port);
      }

      const [byOwner] = await db
        .select()
        .from(hostPortClaim)
        .where(
          and(
            eq(hostPortClaim.targetKey, input.targetKey),
            eq(hostPortClaim.projectId, input.projectId),
            nullableServiceCondition(input.serviceId),
            nullableContainerPortCondition(input.containerPort),
          ),
        )
        .limit(1);
      if (byOwner) {
        throw new HostPortClaimConflictError("owner", input.targetKey, input.port);
      }
    }

    throw new Error(`Host-port reservation changed concurrently on ${input.targetKey}; retry`);
  };

  return {
    /** Every claim in one physical bind namespace, across every organization. */
    async listHostPortClaims(targetKey: HostPortTargetKey): Promise<HostPortClaim[]> {
      assertTargetKey(targetKey);
      return db
        .select()
        .from(hostPortClaim)
        .where(eq(hostPortClaim.targetKey, targetKey))
        .orderBy(asc(hostPortClaim.port), asc(hostPortClaim.createdAt));
    },

    /**
     * Atomically reserve a target/port for one stable owner.
     *
     * The unique indexes arbitrate concurrent callers. Repeating the exact same
     * reservation is idempotent. A matching legacy scalar is atomically refined
     * with its first observed container port; either a different owner on the
     * port or a different port for this exact owner raises
     * HostPortClaimConflictError.
     */
    async reserveHostPortClaim(input: HostPortClaimIdentity): Promise<HostPortClaim> {
      validateIdentity(input);
      assertWorkloadOwner(input);
      return reserveIdentity(input);
    },

    /** Reserve an unowned/orphan edge port under the impossible sentinel owner. */
    async reserveQuarantinedHostPortClaim(input: {
      targetKey: HostPortTargetKey;
      port: number;
    }): Promise<HostPortClaim> {
      const identity: HostPortClaimIdentity = {
        ...input,
        projectId: HOST_PORT_QUARANTINE_OWNER,
        serviceId: HOST_PORT_QUARANTINE_OWNER,
        containerPort: input.port,
      };
      validateIdentity(identity);
      return reserveIdentity(identity);
    },

    /**
     * Release only the exact internal quarantine row after a caller has proved
     * the physical edge no longer dials it. Keeping this separate from workload
     * release preserves the sentinel's unforgeable public boundary.
     */
    async releaseQuarantinedHostPortClaim(input: {
      targetKey: HostPortTargetKey;
      port: number;
    }): Promise<boolean> {
      assertTargetKey(input.targetKey);
      assertPort(input.port, "port");
      const removed = await db
        .delete(hostPortClaim)
        .where(
          and(
            eq(hostPortClaim.targetKey, input.targetKey),
            eq(hostPortClaim.port, input.port),
            eq(hostPortClaim.projectId, HOST_PORT_QUARANTINE_OWNER),
            eq(hostPortClaim.serviceId, HOST_PORT_QUARANTINE_OWNER),
            eq(hostPortClaim.containerPort, input.port),
          ),
        )
        .returning();
      return removed.length > 0;
    },

    /** Release only the exact row observed by the caller; stale releases are harmless. */
    async releaseHostPortClaim(input: HostPortClaimIdentity): Promise<boolean> {
      validateIdentity(input);
      assertWorkloadOwner(input);
      const removed = await db
        .delete(hostPortClaim)
        .where(
          and(
            eq(hostPortClaim.targetKey, input.targetKey),
            eq(hostPortClaim.port, input.port),
            eq(hostPortClaim.projectId, input.projectId),
            nullableServiceCondition(input.serviceId),
            nullableContainerPortCondition(input.containerPort),
          ),
        )
        .returning();
      return removed.length > 0;
    },

    /** Release every port for one project/service on one physical target. */
    async releaseHostPortClaimsForOwner(input: HostPortClaimOwner): Promise<number> {
      assertTargetKey(input.targetKey);
      assertOwner(input);
      assertWorkloadOwner(input);
      const removed = await db.delete(hostPortClaim).where(ownerScope(input)).returning();
      return removed.length;
    },

    /**
     * Drop owner claims not present in the caller's authoritative routed-port
     * set. This only prunes; reserve the kept rows first so a partial failure
     * cannot release the old claims before their replacements are durable.
     */
    async pruneHostPortClaimsForOwner(input: PruneHostPortClaimsInput): Promise<number> {
      assertTargetKey(input.targetKey);
      assertOwner(input);
      assertWorkloadOwner(input);

      const containerPorts = new Set<string>();
      const hostPorts = new Set<number>();
      for (const kept of input.keep) {
        assertPort(kept.port, "port");
        if (kept.containerPort !== null) assertPort(kept.containerPort, "containerPort");
        const ownerKey = kept.containerPort === null ? "legacy" : String(kept.containerPort);
        if (containerPorts.has(ownerKey)) {
          throw new TypeError("keep contains the same containerPort more than once");
        }
        if (hostPorts.has(kept.port)) {
          throw new TypeError("keep contains the same host port more than once");
        }
        containerPorts.add(ownerKey);
        hostPorts.add(kept.port);
      }

      if (input.keep.length === 0) {
        const removed = await db.delete(hostPortClaim).where(ownerScope(input)).returning();
        return removed.length;
      }

      const keepCondition = or(
        ...input.keep.map((kept) =>
          and(
            eq(hostPortClaim.port, kept.port),
            nullableContainerPortCondition(kept.containerPort),
          ),
        ),
      )!;
      const removed = await db
        .delete(hostPortClaim)
        .where(and(ownerScope(input), not(keepCondition)))
        .returning();
      return removed.length;
    },
  };
}
