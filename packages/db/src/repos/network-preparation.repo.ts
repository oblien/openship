import { and, desc, eq, gt, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import {
  AppError,
  NotFoundError,
  MANAGED_NETWORK_LEASE_MS,
  MANAGED_NETWORK_PREPARATION_STEPS,
  type ManagedNetworkPreparationHost,
  type ManagedNetworkPreparationInput,
} from "@repo/core";
import type { Database } from "../client";
import { managedNetworkPreparation as table, managedNetworkOperation } from "../schema";
import { discardNetworkSetup } from "./network-setup-discard";
import {
  removeNetworkSetupMember,
  type RemoveNetworkSetupMemberTarget,
  reviseNetworkSetupAccess,
  type ReviseNetworkAccessTarget,
} from "./network-setup-member";

export type NetworkPreparationRecord = typeof table.$inferSelect;
const conflict = (message: string) => new AppError(message, 409, "NETWORK_PREPARATION_CONFLICT");

export function createNetworkPreparationRepo(db: Database) {
  const owned = (org: string, id: string) => and(eq(table.id, id), eq(table.organizationId, org));
  const worker = (id: string, generation: number) =>
    and(
      eq(table.id, id),
      eq(table.generation, generation),
      eq(table.status, "preparing"),
      gt(table.leaseExpiresAt, new Date()),
    );
  async function interrupt(condition: SQL | undefined, error: string) {
    const rows = await db
      .update(table)
      .set({
        status: "interrupted",
        sequence: sql`${table.sequence} + 1`,
        leaseExpiresAt: null,
        updatedAt: new Date(),
        error,
      })
      .where(and(eq(table.status, "preparing"), condition))
      .returning();
    return rows.map(({ id, organizationId }) => ({ id, organizationId }));
  }
  const expiredLease = () =>
    or(isNull(table.leaseExpiresAt), lte(table.leaseExpiresAt, new Date()));
  async function expire(org: string) {
    await interrupt(
      and(eq(table.organizationId, org), expiredLease()),
      "The controller stopped reporting progress. Retry preparation to recheck each server and continue installing missing tools.",
    );
  }
  async function get(org: string, id: string) {
    await expire(org);
    const [row] = await db.select().from(table).where(owned(org, id));
    if (!row) throw new NotFoundError("Network preparation", id);
    return row;
  }
  return {
    get,
    /** Only an exclusive database owner may stop runs whose leases are still valid. */
    async recoverInterrupted(exclusive: boolean) {
      return interrupt(
        exclusive ? undefined : expiredLease(),
        exclusive
          ? "OpenShip restarted before server preparation finished. Retry preparation to recheck each server and continue installing missing tools."
          : "The controller stopped reporting progress. Retry preparation to recheck each server and continue installing missing tools.",
      );
    },
    async interrupt(id: string, generation: number, error: string) {
      return interrupt(and(eq(table.id, id), eq(table.generation, generation)), error);
    },
    async removeMember(org: string, createdBy: string, target: RemoveNetworkSetupMemberTarget) {
      await expire(org);
      return removeNetworkSetupMember(db, org, createdBy, target);
    },
    async reviseAccess(org: string, createdBy: string, target: ReviseNetworkAccessTarget) {
      await expire(org);
      return reviseNetworkSetupAccess(db, org, createdBy, target);
    },
    async interruptPending(org: string, id: string, error: string) {
      await db
        .update(table)
        .set({
          status: "interrupted",
          error,
          sequence: sql`${table.sequence} + 1`,
          updatedAt: new Date(),
        })
        .where(and(owned(org, id), eq(table.status, "pending")));
    },
    async discard(org: string, id: string, sequence: number) {
      await expire(org);
      return discardNetworkSetup(db, org, { preparationId: id, sequence });
    },
    async list(org: string) {
      await expire(org);
      const rows = await db
        .select({
          id: table.id,
          sequence: table.sequence,
          status: table.status,
          error: table.error,
          name: sql<string>`${table.input}->>'name'`,
          serverCount: sql<number>`jsonb_array_length(${table.hosts})`,
          operationId: table.operationId,
          createdAt: table.createdAt,
          updatedAt: table.updatedAt,
        })
        .from(table)
        .leftJoin(managedNetworkOperation, eq(table.operationId, managedNetworkOperation.id))
        .where(
          and(
            eq(table.organizationId, org),
            ne(table.status, "cancelled"),
            or(
              isNull(managedNetworkOperation.status),
              eq(managedNetworkOperation.status, "planned"),
            ),
          ),
        )
        .orderBy(desc(table.createdAt))
        .limit(20);
      return rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));
    },
    async start(
      org: string,
      createdBy: string,
      inputHash: string,
      input: ManagedNetworkPreparationInput,
      hosts: ManagedNetworkPreparationHost[],
    ) {
      await expire(org);
      return db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(table)
          .values({
            id: input.requestId,
            organizationId: org,
            createdBy,
            inputHash,
            input,
            hosts,
            status: "preparing",
            leaseExpiresAt: new Date(Date.now() + MANAGED_NETWORK_LEASE_MS),
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) return { preparation: inserted, started: true };
        const [existing] = await tx
          .select()
          .from(table)
          .where(owned(org, input.requestId))
          .for("update");
        if (!existing) throw new NotFoundError("Network preparation");
        if (existing.inputHash !== inputHash)
          throw conflict(
            "This preparation request already has different settings. Start a new preparation after editing.",
          );
        if (existing.status === "cancelled")
          throw conflict(
            "This setup was discarded. Start a new setup to prepare these servers again.",
          );
        if (existing.status === "preparing" || existing.status === "ready")
          return { preparation: existing, started: false };
        if (existing.cleanupOperationId) {
          const [cleanup] = await tx
            .select()
            .from(managedNetworkOperation)
            .where(
              and(
                eq(managedNetworkOperation.id, existing.cleanupOperationId),
                eq(managedNetworkOperation.organizationId, org),
              ),
            );
          if (
            !cleanup ||
            cleanup.status !== "rolled_back" ||
            cleanup.replacementPreparationId !== existing.id
          )
            throw conflict(
              "Finish resetting the previous network setup on every server before continuing preparation.",
            );
        }
        const [next] = await tx
          .update(table)
          .set({
            status: "preparing",
            error: null,
            generation: existing.generation + 1,
            sequence: sql`${table.sequence} + 1`,
            leaseExpiresAt: new Date(Date.now() + MANAGED_NETWORK_LEASE_MS),
            updatedAt: new Date(),
          })
          .where(owned(org, input.requestId))
          .returning();
        return { preparation: next!, started: true };
      });
    },
    async active(id: string, generation: number) {
      return (
        (await db.select({ id: table.id }).from(table).where(worker(id, generation))).length > 0
      );
    },
    async heartbeat(id: string, generation: number) {
      const rows = await db
        .update(table)
        .set({
          leaseExpiresAt: new Date(Date.now() + MANAGED_NETWORK_LEASE_MS),
          updatedAt: new Date(),
        })
        .where(worker(id, generation))
        .returning();
      return rows.length > 0;
    },
    async progress(id: string, generation: number, hosts: ManagedNetworkPreparationHost[]) {
      const rows = await db
        .update(table)
        .set({ hosts, sequence: sql`${table.sequence} + 1`, updatedAt: new Date() })
        .where(worker(id, generation))
        .returning();
      if (!rows.length) throw conflict("This worker no longer owns server preparation.");
    },
    async finish(
      id: string,
      generation: number,
      hosts: ManagedNetworkPreparationHost[],
      operationId: string | null,
      error: string | null,
    ) {
      if (
        operationId &&
        (error ||
          hosts.length < 2 ||
          new Set(hosts.map((host) => host.serverId)).size !== hosts.length ||
          hosts.some(
            (host) =>
              !host.hostIdentity ||
              MANAGED_NETWORK_PREPARATION_STEPS.some(
                (id) => host.steps.find((step) => step.id === id)?.status !== "completed",
              ),
          ))
      )
        throw conflict("Every server prerequisite must pass before reviewing the network.");
      const rows = await db
        .update(table)
        .set({
          hosts,
          operationId,
          error,
          status: operationId ? "ready" : "failed",
          sequence: sql`${table.sequence} + 1`,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(worker(id, generation))
        .returning();
      if (!rows.length) throw conflict("This worker no longer owns server preparation.");
    },
  };
}
