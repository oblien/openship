import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { AppError, generateId } from "@repo/core";
import type { Database } from "../client";
import {
  actionStorageObject as objects,
  actionStorageChunk as chunks,
} from "../schema/action-storage";
import { organization } from "../schema/organization";

export type ActionStorageObject = typeof objects.$inferSelect;
export type ActionStorageChunk = typeof chunks.$inferSelect;
type NewObject = typeof objects.$inferInsert;

export function createActionStorageRepo(db: Database) {
  const owned = (org: string, id: number) =>
    and(eq(objects.organizationId, org), eq(objects.id, id));
  return {
    async get(org: string, id: number) {
      return (await db.select().from(objects).where(owned(org, id)).limit(1))[0];
    },
    async forJob(
      org: string,
      jobId: string,
      kind: "artifact" | "cache",
      name: string,
      version = "",
    ) {
      return (
        await db
          .select()
          .from(objects)
          .where(
            and(
              eq(objects.organizationId, org),
              eq(objects.jobId, jobId),
              eq(objects.kind, kind),
              eq(objects.name, name),
              eq(objects.version, version),
              sql`${objects.state} <> 'deleting'`,
            ),
          )
          .orderBy(desc(objects.createdAt))
          .limit(1)
      )[0];
    },
    async artifacts(org: string, runId: string) {
      return db
        .select()
        .from(objects)
        .where(
          and(
            eq(objects.organizationId, org),
            eq(objects.runId, runId),
            eq(objects.kind, "artifact"),
            eq(objects.state, "complete"),
            gt(objects.expiresAt, new Date()),
          ),
        )
        .orderBy(asc(objects.createdAt));
    },
    async candidates(
      org: string,
      repo: string,
      destinationId: string,
      refs: string[],
      version: string,
    ) {
      return db
        .select()
        .from(objects)
        .where(
          and(
            eq(objects.organizationId, org),
            eq(objects.destinationId, destinationId),
            eq(objects.kind, "cache"),
            eq(objects.repository, repo),
            inArray(objects.ref, refs),
            eq(objects.version, version),
            eq(objects.state, "complete"),
            gt(objects.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(objects.createdAt))
        .limit(1000);
    },
    async reserve(
      input: NewObject,
      quotaBytes: number,
      maxObjects: number,
    ): Promise<ActionStorageObject> {
      return db.transaction(async (tx) => {
        await tx
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.id, input.organizationId))
          .for("update");
        const duplicate = await tx
          .select()
          .from(objects)
          .where(
            and(
              eq(objects.organizationId, input.organizationId),
              eq(objects.kind, input.kind),
              eq(objects.name, input.name),
              input.kind === "artifact"
                ? eq(objects.runId, input.runId)
                : and(
                    eq(objects.repository, input.repository),
                    eq(objects.ref, input.ref),
                    eq(objects.version, input.version ?? ""),
                  ),
              gt(objects.expiresAt, new Date()),
              sql`${objects.state} <> 'deleting'`,
            ),
          )
          .limit(1);
        if (duplicate[0]) {
          if (duplicate[0].jobId === input.jobId && duplicate[0].state !== "complete")
            return duplicate[0];
          throw new AppError(
            "An artifact or cache with this name already exists",
            409,
            "ACTIONS_STORAGE_CONFLICT",
          );
        }
        const [usage] = await tx
          .select({
            bytes: sql<string>`coalesce(sum(${objects.reservedBytes}), 0)`,
            count: sql<number>`count(*)::int`,
          })
          .from(objects)
          .where(eq(objects.organizationId, input.organizationId));
        if (
          Number(usage?.bytes ?? 0) + input.reservedBytes > quotaBytes ||
          (usage?.count ?? 0) >= maxObjects
        )
          throw new AppError(
            "Actions storage allowance is full. Remove old artifacts or caches before uploading more.",
            409,
            "ACTIONS_STORAGE_FULL",
          );
        return (await tx.insert(objects).values(input).returning())[0]!;
      });
    },
    async addChunk(
      org: string,
      id: number,
      name: string,
      size: number,
    ): Promise<ActionStorageChunk> {
      return db.transaction(async (tx) => {
        const [object] = await tx.select().from(objects).where(owned(org, id)).for("update");
        if (!object || object.state !== "pending" || object.expiresAt <= new Date())
          throw new AppError("This upload is no longer writable", 409, "ACTIONS_UPLOAD_CLOSED");
        const [usage] = await tx
          .select({
            bytes: sql<string>`coalesce(sum(${chunks.size}), 0)`,
            count: sql<number>`count(*)::int`,
          })
          .from(chunks)
          .where(eq(chunks.objectId, id));
        // Retries also consume temporary storage until cleanup; never leave
        // unaccounted objects after an uncertain storage response.
        if (Number(usage?.bytes ?? 0) + size > object.maxBytes * 3 || (usage?.count ?? 0) >= 1024)
          throw new AppError(
            "Upload exceeded its temporary storage allowance",
            413,
            "ACTIONS_UPLOAD_TOO_LARGE",
          );
        const chunkId = generateId("achunk");
        return (
          await tx
            .insert(chunks)
            .values({
              id: chunkId,
              organizationId: org,
              objectId: id,
              name,
              key: `${object.key}.parts/${chunkId}`,
              size,
            })
            .returning()
        )[0]!;
      });
    },
    async completeChunk(org: string, id: string, hash: string) {
      await db
        .update(chunks)
        .set({ sha256: hash, state: "complete" })
        .where(and(eq(chunks.organizationId, org), eq(chunks.id, id)));
    },
    async chunks(org: string, id: number) {
      return db
        .select()
        .from(chunks)
        .where(and(eq(chunks.organizationId, org), eq(chunks.objectId, id)))
        .orderBy(asc(chunks.createdAt), asc(chunks.id));
    },
    async beginAssembly(org: string, id: number, size: number) {
      return db.transaction(async (tx) => {
        const [object] = await tx.select().from(objects).where(owned(org, id)).for("update");
        if (
          !object ||
          (object.state !== "pending" &&
            !(
              object.state === "assembling" &&
              object.leaseUntil &&
              object.leaseUntil <= new Date()
            ))
        )
          return undefined;
        const [usage] = await tx
          .select({
            bytes: sql<string>`coalesce(sum(${chunks.size}), 0)`,
            count: sql<number>`count(*)::int`,
          })
          .from(chunks)
          .where(eq(chunks.objectId, id));
        if (Number(usage?.bytes ?? 0) + size > object.maxBytes * 4 || (usage?.count ?? 0) >= 1024)
          throw new AppError(
            "Upload exceeded its temporary storage allowance",
            413,
            "ACTIONS_UPLOAD_TOO_LARGE",
          );
        // Every assembly uses its own immutable key. A late upload from an
        // expired lease can never overwrite the winning attempt's bytes.
        const leaseOwner = generateId("achunk");
        const [attempt] = await tx
          .insert(chunks)
          .values({
            id: leaseOwner,
            organizationId: org,
            objectId: id,
            kind: "assembly",
            name: "final",
            key: `${object.key}.assemblies/${leaseOwner}`,
            size,
          })
          .returning();
        await tx
          .update(objects)
          .set({
            state: "assembling",
            leaseOwner,
            leaseUntil: new Date(Date.now() + 15 * 60_000),
            updatedAt: new Date(),
          })
          .where(owned(org, id));
        return attempt;
      });
    },
    async uploaded(org: string, id: number, attemptId: string, sha256: string) {
      return db.transaction(async (tx) => {
        const [attempt] = await tx
          .select()
          .from(chunks)
          .where(
            and(
              eq(chunks.organizationId, org),
              eq(chunks.objectId, id),
              eq(chunks.id, attemptId),
              eq(chunks.kind, "assembly"),
            ),
          );
        if (!attempt) return undefined;
        const [row] = await tx
          .update(objects)
          .set({
            state: "uploaded",
            size: attempt.size,
            sha256,
            finalKey: attempt.key,
            leaseOwner: null,
            leaseUntil: null,
            updatedAt: new Date(),
          })
          .where(
            and(owned(org, id), eq(objects.state, "assembling"), eq(objects.leaseOwner, attemptId)),
          )
          .returning();
        await tx.update(chunks).set({ state: "complete", sha256 }).where(eq(chunks.id, attemptId));
        return row;
      });
    },
    async releaseAssembly(org: string, id: number, attemptId: string) {
      await db
        .update(objects)
        .set({ state: "pending", leaseOwner: null, leaseUntil: null, updatedAt: new Date() })
        .where(
          and(owned(org, id), eq(objects.state, "assembling"), eq(objects.leaseOwner, attemptId)),
        );
    },
    async complete(org: string, id: number) {
      return (
        await db
          .update(objects)
          .set({ state: "complete", updatedAt: new Date() })
          .where(and(owned(org, id), eq(objects.state, "uploaded")))
          .returning()
      )[0];
    },
    async markDeleting(org: string, id: number) {
      return (
        await db
          .update(objects)
          .set({ state: "deleting", updatedAt: new Date() })
          .where(owned(org, id))
          .returning()
      )[0];
    },
    async remove(org: string, id: number) {
      await db.delete(objects).where(and(owned(org, id), eq(objects.state, "deleting")));
    },
    async removeChunks(org: string, id: number) {
      await db.transaction(async (tx) => {
        await tx.delete(chunks).where(and(eq(chunks.organizationId, org), eq(chunks.objectId, id)));
        await tx
          .update(objects)
          .set({ reservedBytes: sql`${objects.size}` })
          .where(and(owned(org, id), eq(objects.state, "complete")));
      });
    },
    async completeWithChunks(limit = 20) {
      return db
        .select()
        .from(objects)
        .where(
          and(
            eq(objects.state, "complete"),
            sql`EXISTS (SELECT 1 FROM ${chunks} WHERE ${chunks.objectId} = ${objects.id})`,
          ),
        )
        .limit(limit);
    },
    async expired(limit = 50) {
      return db
        .select()
        .from(objects)
        .where(
          or(
            lt(objects.expiresAt, new Date()),
            eq(objects.state, "deleting"),
            and(
              sql`${objects.state} <> 'complete'`,
              lt(objects.createdAt, new Date(Date.now() - 24 * 60 * 60_000)),
            ),
          ),
        )
        .orderBy(asc(objects.updatedAt))
        .limit(limit);
    },
  };
}
