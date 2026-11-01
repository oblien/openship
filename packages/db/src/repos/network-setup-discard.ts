import { and, eq, sql } from "drizzle-orm";
import { AppError, NotFoundError } from "@repo/core";
import type { Database } from "../client";
import { managedNetworkOperation, managedNetworkPreparation } from "../schema";

type Target =
  | { preparationId: string; sequence: number }
  | { operationId: string; planHash: string };
const conflict = (message: string) => new AppError(message, 409, "NETWORK_SETUP_CONFLICT");

/** Keep a terminal record so delayed retries cannot recreate a discarded setup. */
export async function discardNetworkSetup(db: Database, org: string, target: Target) {
  return db.transaction(async (tx) => {
    const operationTarget = "operationId" in target;
    // Plans are immutable. Discover the preparation, then always lock preparation
    // before operation, matching plan publication and avoiding an orphaned plan.
    const [original] = operationTarget
      ? await tx
          .select()
          .from(managedNetworkOperation)
          .where(
            and(
              eq(managedNetworkOperation.organizationId, org),
              eq(managedNetworkOperation.id, target.operationId),
            ),
          )
      : [];
    if (operationTarget && !original) throw new NotFoundError("Network operation");
    const preparationId = operationTarget
      ? (original!.plan.preparationId ?? original!.id)
      : target.preparationId;
    let [preparation] = await tx
      .select()
      .from(managedNetworkPreparation)
      .where(
        and(
          eq(managedNetworkPreparation.organizationId, org),
          eq(managedNetworkPreparation.id, preparationId),
        ),
      )
      .for("update");
    if (!operationTarget && !preparation) throw new NotFoundError("Network preparation");
    if (preparation?.status === "preparing")
      throw conflict(
        "Server preparation is still running. Wait for it to finish before discarding setup.",
      );
    if (preparation?.cleanupOperationId) {
      const [cleanup] = await tx
        .select()
        .from(managedNetworkOperation)
        .where(
          and(
            eq(managedNetworkOperation.organizationId, org),
            eq(managedNetworkOperation.id, preparation.cleanupOperationId),
          ),
        );
      if (!cleanup || cleanup.status !== "rolled_back")
        throw conflict(
          "Finish resetting the previous network setup before closing its continuation.",
        );
    }
    if (
      !operationTarget &&
      preparation!.status !== "cancelled" &&
      preparation!.sequence !== target.sequence
    )
      throw conflict("Preparation changed. Reload its saved progress before discarding it.");

    const operationId = operationTarget
      ? target.operationId
      : (preparation!.operationId ?? preparation!.id);
    let [operation] = await tx
      .select()
      .from(managedNetworkOperation)
      .where(
        and(
          eq(managedNetworkOperation.organizationId, org),
          eq(managedNetworkOperation.id, operationId),
        ),
      )
      .for("update");
    if (operationTarget && !operation) throw new NotFoundError("Network operation");
    if (operation && operationTarget && operation.planHash !== target.planHash)
      throw conflict("The reviewed plan changed. Reload it before discarding it.");
    const cleanedUp = !operationTarget && operation?.status === "rolled_back";
    if (
      operation &&
      operation.status !== "planned" &&
      operation.status !== "cancelled" &&
      !cleanedUp
    )
      throw conflict(
        "Network changes have already started. Open the operation and clean up or restore its network before closing setup.",
      );

    if (operation?.status === "planned") {
      [operation] = await tx
        .update(managedNetworkOperation)
        .set({
          status: "cancelled",
          generation: sql`${managedNetworkOperation.generation} + 1`,
          sequence: sql`${managedNetworkOperation.sequence} + 1`,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(managedNetworkOperation.id, operation.id))
        .returning();
    }
    if (preparation && preparation.status !== "cancelled") {
      [preparation] = await tx
        .update(managedNetworkPreparation)
        .set({
          status: "cancelled",
          operationId: operation?.id ?? preparation.operationId,
          generation: sql`${managedNetworkPreparation.generation} + 1`,
          sequence: sql`${managedNetworkPreparation.sequence} + 1`,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(managedNetworkPreparation.id, preparation.id))
        .returning();
    }
    return { preparation: preparation ?? null, operation: operation ?? null };
  });
}
