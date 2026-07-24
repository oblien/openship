import { eq, and, inArray } from "drizzle-orm";
import type { Database } from "../client";
import { servers } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Server = typeof servers.$inferSelect;
export type NewServer = typeof servers.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createServerRepo(db: Database) {
  return {
    /** List all servers, ordered by creation date */
    async list(): Promise<Server[]> {
      return db.query.servers.findMany({
        orderBy: (s, { asc }) => [asc(s.createdAt)],
      });
    },

    /**
     * Org-scoped list. Returns only servers whose organization_id exactly
     * matches the caller's org. NULL-org rows are NOT returned and remain
     * invisible from the dashboard.
     */
    async listByOrganization(organizationId: string): Promise<Server[]> {
      return db.query.servers.findMany({
        where: eq(servers.organizationId, organizationId),
        orderBy: (s, { asc }) => [asc(s.createdAt)],
      });
    },

    /** Org-scoped get. Strict equality — NULL-org rows are invisible. */
    async getInOrganization(id: string, organizationId: string): Promise<Server | undefined> {
      return db.query.servers.findFirst({
        where: and(eq(servers.id, id), eq(servers.organizationId, organizationId)),
      });
    },

    /** Get a single server by ID */
    async get(id: string): Promise<Server | undefined> {
      return db.query.servers.findFirst({
        where: eq(servers.id, id),
      });
    },

    /**
     * The auto-registered "this host" row (VPS / server-host mode), if any.
     * Scoped to one org because the self-server is created in the founding
     * admin's org. Used by the boot reconcile for idempotency.
     */
    async findLocal(organizationId: string): Promise<Server | undefined> {
      return db.query.servers.findFirst({
        where: and(eq(servers.organizationId, organizationId), eq(servers.isLocal, true)),
      });
    },

    /**
     * Bulk lookup — used by enrichProjectsBatch to resolve server
     * names for many projects in one round trip instead of one query
     * per project. Returns Map<id, Server> with no entry for unknown
     * ids (so callers can `.get(id)?.name`).
     */
    async getMany(ids: string[]): Promise<Map<string, Server>> {
      if (ids.length === 0) return new Map();
      const rows = await db
        .select()
        .from(servers)
        .where(inArray(servers.id, ids));
      const out = new Map<string, Server>();
      for (const row of rows) out.set(row.id, row);
      return out;
    },

    /** Create a new server */
    async create(data: Omit<NewServer, "id" | "createdAt" | "updatedAt">): Promise<Server> {
      const [row] = await db
        .insert(servers)
        .values(data)
        .returning();
      return row;
    },

    /** Update an existing server */
    async update(
      id: string,
      data: Partial<Omit<NewServer, "id" | "createdAt">>,
    ): Promise<Server> {
      const [row] = await db
        .update(servers)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(servers.id, id))
        .returning();
      return row;
    },

    /** Delete a server by ID */
    async delete(id: string): Promise<void> {
      await db.delete(servers).where(eq(servers.id, id));
    },
  };
}
