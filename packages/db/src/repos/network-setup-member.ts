import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  AppError,
  ClusterConfigError,
  NotFoundError,
  initialManagedNetworkInput,
  withoutManagedNetworkMember,
  managedNetworkInProgress,
  managedNetworkSteps,
  MANAGED_NETWORK_PREPARATION_STEPS,
  normalizeManagedNetworkInput,
  normalizeNetworkAccess,
  type NetworkAccessPolicy,
} from "@repo/core";
import type { Database } from "../client";
import {
  managedNetworkOperation as operations,
  managedNetworkPreparation as preparations,
} from "../schema";

export type RemoveNetworkSetupMemberTarget = {
  serverId: string;
  requestId: string;
  sequence: number;
} & ({ preparationId: string } | { operationId: string; planHash: string });
const conflict = (message: string) => new AppError(message, 409, "NETWORK_SETUP_CONFLICT");

export type ReviseNetworkAccessTarget = {
  preparationId: string;
  requestId: string;
  sequence: number;
  access: NetworkAccessPolicy;
};

/** Preserve the original journal and reservations until its normal rollback acknowledges every host. */
export async function removeNetworkSetupMember(
  db: Database,
  org: string,
  createdBy: string,
  target: RemoveNetworkSetupMemberTarget,
) {
  return replaceNetworkSetup(db, org, createdBy, target);
}

export async function reviseNetworkSetupAccess(
  db: Database,
  org: string,
  createdBy: string,
  target: ReviseNetworkAccessTarget,
) {
  return replaceNetworkSetup(db, org, createdBy, target);
}

/** A new immutable draft atomically supersedes its old preparation and unapplied plan. */
async function replaceNetworkSetup(
  db: Database,
  org: string,
  createdBy: string,
  target: RemoveNetworkSetupMemberTarget | ReviseNetworkAccessTarget,
) {
  return db.transaction(async (tx) => {
    const changingAccess = "access" in target;
    const operationTarget = "operationId" in target;
    const [original] = operationTarget
      ? await tx
          .select()
          .from(operations)
          .where(and(eq(operations.organizationId, org), eq(operations.id, target.operationId)))
      : [];
    if (operationTarget && !original) throw new NotFoundError("Network operation");
    // Same lock order as plan publication and discard: preparation, then operation.
    const preparationId = operationTarget
      ? (original!.plan.preparationId ?? original!.id)
      : target.preparationId;
    let [sourcePreparation] = await tx
      .select()
      .from(preparations)
      .where(and(eq(preparations.organizationId, org), eq(preparations.id, preparationId)))
      .for("update");
    if (!operationTarget && !sourcePreparation) throw new NotFoundError("Network preparation");
    const operationId = operationTarget
      ? target.operationId
      : (sourcePreparation!.operationId ?? sourcePreparation!.id);
    let [operation] = await tx
      .select()
      .from(operations)
      .where(and(eq(operations.organizationId, org), eq(operations.id, operationId)))
      .for("update");
    if (operationTarget && !operation) throw new NotFoundError("Network operation");
    if (operationTarget && operation!.planHash !== target.planHash)
      throw conflict("The reviewed plan changed. Reload setup before removing a server.");

    let input;
    try {
      if (changingAccess) {
        const originalInput = sourcePreparation!.input;
        if (originalInput.intent === "remove")
          throw conflict("A network removal cannot be changed into a connection edit.");
        if (originalInput.requestId === target.requestId)
          throw conflict("Connection changes need a new setup request.");
        input = normalizeManagedNetworkInput({
          ...originalInput,
          ...(operation
            ? {
                cidr: operation.plan.config.network.cidrs[0],
                mtu: operation.plan.config.network.mtu,
                probePort: operation.plan.config.network.probePort,
              }
            : {}),
          requestId: target.requestId,
          access: normalizeNetworkAccess(
            target.access,
            originalInput.members.map((member) => member.serverId),
          ),
        });
      } else {
        const originalInput = operation
          ? initialManagedNetworkInput(operation.plan, operation.id)
          : sourcePreparation!.input;
        input = withoutManagedNetworkMember(originalInput, target.serverId, target.requestId);
      }
    } catch (error) {
      if (error instanceof ClusterConfigError) throw conflict(error.message);
      throw error;
    }
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const replacementId =
      operation?.replacementPreparationId ?? sourcePreparation?.replacementPreparationId;
    if (replacementId) {
      if (replacementId !== target.requestId)
        throw conflict("This selection has already changed. Open the updated setup.");
      const [preparation] = await tx
        .select()
        .from(preparations)
        .where(and(eq(preparations.organizationId, org), eq(preparations.id, replacementId)));
      if (!preparation || preparation.inputHash !== inputHash)
        throw conflict(
          changingAccess
            ? "This request already has different setup changes. Open the updated setup."
            : "This request already removes a different server. Open the updated setup.",
        );
      return {
        preparation,
        sourcePreparation: sourcePreparation ?? null,
        operation: operation ?? null,
      };
    }
    if (
      sourcePreparation?.status === "preparing" ||
      (operation && managedNetworkInProgress(operation.status))
    )
      throw conflict(
        "Setup is still running. Wait for it to finish before changing its configuration.",
      );
    if (
      sourcePreparation &&
      (!["pending", "failed", "interrupted", "ready"].includes(sourcePreparation.status) ||
        (sourcePreparation.status === "pending" && sourcePreparation.cleanupOperationId))
    )
      throw conflict("This setup is closed or waiting for cleanup. Open its saved progress.");
    if (
      operation &&
      !["planned", "interrupted", "needs_attention", "rolled_back"].includes(operation.status)
    )
      throw conflict("Only an unfinished initial cluster setup can change its server selection.");
    if (changingAccess && operation && operation.status !== "planned")
      throw conflict(
        "Restore the applied network changes before editing connections. Then start a new reviewed change from the network settings.",
      );
    const sequence = operationTarget ? operation!.sequence : sourcePreparation!.sequence;
    if (sequence !== target.sequence)
      throw conflict("Setup changed. Reload its saved progress before changing its configuration.");
    const cleanupOperationId = operation && operation.status !== "planned" ? operation.id : null;
    const hosts = input.members.map((member) => {
      const prior = sourcePreparation?.hosts.find((host) => host.serverId === member.serverId);
      const planned = operation?.plan.hosts.find((host) => host.serverId === member.serverId);
      return (
        prior ?? {
          serverId: member.serverId,
          name: planned?.name ?? member.serverId,
          address: planned?.endpoint ?? member.endpoint ?? "",
          hostIdentity: planned?.hostIdentity ?? null,
          steps: managedNetworkSteps(MANAGED_NETWORK_PREPARATION_STEPS),
          logs: [],
        }
      );
    });
    const [preparation] = await tx
      .insert(preparations)
      .values({
        id: target.requestId,
        organizationId: org,
        createdBy,
        input,
        inputHash,
        hosts,
        status: "pending",
        cleanupOperationId,
      })
      .onConflictDoNothing()
      .returning();
    if (!preparation)
      throw conflict("This request already belongs to another setup. Reload and try again.");
    if (operation) {
      [operation] = await tx
        .update(operations)
        .set({
          replacementPreparationId: preparation.id,
          sequence: sql`${operations.sequence} + 1`,
          updatedAt: new Date(),
          ...(operation.status === "planned"
            ? {
                status: "cancelled" as const,
                generation: operation.generation + 1,
                leaseExpiresAt: null,
              }
            : {}),
        })
        .where(eq(operations.id, operation.id))
        .returning();
    }
    if (sourcePreparation) {
      [sourcePreparation] = await tx
        .update(preparations)
        .set({
          status: "cancelled",
          replacementPreparationId: preparation.id,
          operationId: operation?.id ?? sourcePreparation.operationId,
          generation: sql`${preparations.generation} + 1`,
          sequence: sql`${preparations.sequence} + 1`,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(preparations.id, sourcePreparation.id))
        .returning();
    }
    return {
      preparation,
      sourcePreparation: sourcePreparation ?? null,
      operation: operation ?? null,
    };
  });
}
