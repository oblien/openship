import { and, eq } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { serverModuleStatus } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ServerModuleStatus = typeof serverModuleStatus.$inferSelect;
export type NewServerModuleStatus = typeof serverModuleStatus.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createServerModuleStatusRepo(db: Database) {
  return {
    /** Upsert the scan result for a (server, module). Unique on (serverId, moduleName). */
    async upsert(data: Omit<NewServerModuleStatus, "id">): Promise<void> {
      const id = generateId("sms");
      await db
        .insert(serverModuleStatus)
        .values({ id, ...data })
        .onConflictDoUpdate({
          target: [serverModuleStatus.serverId, serverModuleStatus.moduleName],
          set: {
            organizationId: data.organizationId ?? null,
            installedVersion: data.installedVersion ?? null,
            migrationVersion: data.migrationVersion ?? null,
            availableVersion: data.availableVersion ?? null,
            behind: data.behind,
            latestInProgress: data.latestInProgress,
            currentLabel: data.currentLabel ?? null,
            latestLabel: data.latestLabel ?? null,
            detail: data.detail ?? null,
            checkedAt: data.checkedAt ?? new Date(),
            updatedAt: new Date(),
          },
        });
    },

    /** All module statuses for a server (stable module order). */
    async listByServer(serverId: string): Promise<ServerModuleStatus[]> {
      const rows = await db.query.serverModuleStatus.findMany({
        where: eq(serverModuleStatus.serverId, serverId),
      });
      return rows.sort((a, b) => a.moduleName.localeCompare(b.moduleName));
    },

    /** Only the org's modules that currently have an update available. */
    async listBehindByOrg(organizationId: string): Promise<ServerModuleStatus[]> {
      const rows = await db.query.serverModuleStatus.findMany({
        where: and(
          eq(serverModuleStatus.organizationId, organizationId),
          eq(serverModuleStatus.behind, true),
        ),
      });
      return rows.sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime());
    },

    async get(serverId: string, moduleName: string): Promise<ServerModuleStatus | undefined> {
      return db.query.serverModuleStatus.findFirst({
        where: and(
          eq(serverModuleStatus.serverId, serverId),
          eq(serverModuleStatus.moduleName, moduleName),
        ),
      });
    },

    /** Mark an in-progress apply (optimistic UI) before running the reconcile. */
    async setInProgress(serverId: string, moduleName: string, inProgress: boolean): Promise<void> {
      await db
        .update(serverModuleStatus)
        .set({ latestInProgress: inProgress, updatedAt: new Date() })
        .where(
          and(
            eq(serverModuleStatus.serverId, serverId),
            eq(serverModuleStatus.moduleName, moduleName),
          ),
        );
    },
  };
}
