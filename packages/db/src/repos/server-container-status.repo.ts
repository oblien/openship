import { and, eq } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { serverContainerStatus } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ServerContainerStatus = typeof serverContainerStatus.$inferSelect;
export type NewServerContainerStatus = typeof serverContainerStatus.$inferInsert;
export type ServerContainerComponent = "edge" | "mail";

// ─── Repository ──────────────────────────────────────────────────────────────

export function createServerContainerStatusRepo(db: Database) {
  return {
    /**
     * Upsert a scan result for a (server, component). Unique on (serverId, component).
     *
     * `latestInProgress` is PRESERVED when the caller omits it: a detect probe knows
     * what the box runs, not whether an apply is mid-flight, and writing its default
     * would clear the flag under a running swap (every scan path — the 6-hourly job,
     * the boot hook, a manual Scan, the dashboard's mount auto-scan — hits this).
     * Only the apply itself, through {@link setInProgress}, owns the flag.
     */
    async upsert(data: Omit<NewServerContainerStatus, "id">): Promise<void> {
      const id = generateId("scs");
      await db
        .insert(serverContainerStatus)
        .values({ id, ...data })
        .onConflictDoUpdate({
          target: [serverContainerStatus.serverId, serverContainerStatus.component],
          set: {
            organizationId: data.organizationId ?? null,
            runningLabel: data.runningLabel ?? null,
            pinnedLabel: data.pinnedLabel ?? null,
            runningVersion: data.runningVersion ?? null,
            pinnedVersion: data.pinnedVersion ?? null,
            behind: data.behind,
            ...(data.latestInProgress === undefined
              ? {}
              : { latestInProgress: data.latestInProgress }),
            detail: data.detail ?? null,
            checkedAt: data.checkedAt ?? new Date(),
            updatedAt: new Date(),
          },
        });
    },

    /**
     * Drop a (server, component) row. Used when a scan finds the component is no
     * longer present on the box (edge removed, mail uninstalled) — leaving the row
     * would keep reporting drift for a container that is gone.
     *
     * A row whose apply is IN PROGRESS is left alone: mid-swap the container is
     * legitimately absent for a moment, and deleting the row there both erases the
     * in-flight state every surface renders and orphans the apply's own
     * `setInProgress(false)` (it would update zero rows).
     */
    async remove(serverId: string, component: ServerContainerComponent): Promise<void> {
      await db
        .delete(serverContainerStatus)
        .where(
          and(
            eq(serverContainerStatus.serverId, serverId),
            eq(serverContainerStatus.component, component),
            eq(serverContainerStatus.latestInProgress, false),
          ),
        );
    },

    /** All container statuses for a server (stable component order). */
    async listByServer(serverId: string): Promise<ServerContainerStatus[]> {
      const rows = await db.query.serverContainerStatus.findMany({
        where: eq(serverContainerStatus.serverId, serverId),
      });
      return rows.sort((a, b) => a.component.localeCompare(b.component));
    },

    /**
     * Every tracked container for the org — behind, up-to-date, AND down — the
     * cache behind the global Infrastructure view. Sorted by (serverId,
     * component) so a server's rows group and order stably across renders.
     */
    async listByOrg(organizationId: string): Promise<ServerContainerStatus[]> {
      const rows = await db.query.serverContainerStatus.findMany({
        where: eq(serverContainerStatus.organizationId, organizationId),
      });
      return rows.sort(
        (a, b) => a.serverId.localeCompare(b.serverId) || a.component.localeCompare(b.component),
      );
    },

    /** Only the org's containers that currently have an update available. */
    async listBehindByOrg(organizationId: string): Promise<ServerContainerStatus[]> {
      const rows = await db.query.serverContainerStatus.findMany({
        where: and(
          eq(serverContainerStatus.organizationId, organizationId),
          eq(serverContainerStatus.behind, true),
        ),
      });
      return rows.sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime());
    },

    async get(
      serverId: string,
      component: ServerContainerComponent,
    ): Promise<ServerContainerStatus | undefined> {
      return db.query.serverContainerStatus.findFirst({
        where: and(
          eq(serverContainerStatus.serverId, serverId),
          eq(serverContainerStatus.component, component),
        ),
      });
    },

    /** Mark an in-progress apply (optimistic UI) before running the swap. */
    async setInProgress(
      serverId: string,
      component: ServerContainerComponent,
      inProgress: boolean,
    ): Promise<void> {
      await db
        .update(serverContainerStatus)
        .set({ latestInProgress: inProgress, updatedAt: new Date() })
        .where(
          and(
            eq(serverContainerStatus.serverId, serverId),
            eq(serverContainerStatus.component, component),
          ),
        );
    },

    /**
     * Clear every in-progress flag. Boot-only: an apply lives in the API process
     * (its session, logs and step model are in memory), so a flag that survived a
     * restart describes a run that no longer exists. Without this the flag is
     * indistinguishable from a live swap and every surface renders a permanent
     * "Updating…" — the very reason readers used to bound their polling.
     */
    async clearAllInProgress(): Promise<void> {
      await db
        .update(serverContainerStatus)
        .set({ latestInProgress: false, updatedAt: new Date() })
        .where(eq(serverContainerStatus.latestInProgress, true));
    },
  };
}
