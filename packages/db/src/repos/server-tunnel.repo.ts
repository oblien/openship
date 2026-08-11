import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { serverTunnels } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ServerTunnel = typeof serverTunnels.$inferSelect;
export type NewServerTunnel = typeof serverTunnels.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

/**
 * Port-forward tunnel CONFIGS — Desktop-only feature.
 *
 * Stores the saved forwards (remote port → localhost) per server. The live
 * tunnels themselves live in RAM (`ssh-tunnel-manager`); this repo is only the
 * durable config so the user's forwards survive restarts and `auto_start` rows
 * can be re-opened at boot. On VPS/SaaS the feature is gated off and this table
 * stays empty.
 */
export function createServerTunnelRepo(db: Database) {
  return {
    /** Every saved forward for a server, oldest-first for deterministic UI. */
    async listByServer(serverId: string): Promise<ServerTunnel[]> {
      return db.query.serverTunnels.findMany({
        where: eq(serverTunnels.serverId, serverId),
        orderBy: (t, { asc }) => [asc(t.createdAt)],
      });
    },

    /** Every saved forward across all servers (used by the boot autostart hook). */
    async listAutoStart(): Promise<ServerTunnel[]> {
      return db.query.serverTunnels.findMany({
        where: eq(serverTunnels.autoStart, true),
        orderBy: (t, { asc }) => [asc(t.createdAt)],
      });
    },

    /** Single config by its id. */
    async get(id: string): Promise<ServerTunnel | undefined> {
      return db.query.serverTunnels.findFirst({
        where: eq(serverTunnels.id, id),
      });
    },

    /**
     * Insert-or-update keyed on (server, remote target). Updating an existing
     * forward keeps its id (and thus any running tunnel keyed off it) stable.
     */
    async upsert(data: NewServerTunnel): Promise<ServerTunnel> {
      const [row] = await db
        .insert(serverTunnels)
        .values(data)
        .onConflictDoUpdate({
          target: [
            serverTunnels.serverId,
            serverTunnels.remotePort,
            serverTunnels.remoteHost,
          ],
          set: {
            localPort: data.localPort,
            autoStart: data.autoStart,
            updatedAt: new Date(),
          },
        })
        .returning();
      return row;
    },

    /** Drop a single forward config. */
    async remove(id: string): Promise<void> {
      await db.delete(serverTunnels).where(eq(serverTunnels.id, id));
    },
  };
}
