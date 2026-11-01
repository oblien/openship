import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import { AppError } from "@repo/core";
import type { Database } from "../client";
import { servers } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Server = typeof servers.$inferSelect;
export type ConnectedServer = Server & { workspaceId: null; sshHost: string };
export type NewServer = typeof servers.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createServerRepo(db: Database) {
  return {
    /** Connected-host inventory for SSH maintenance and infrastructure jobs. */
    async list(): Promise<ConnectedServer[]> {
      return db.query.servers.findMany({
        where: and(isNull(servers.workspaceId), eq(servers.purpose, "deployment")),
        orderBy: (s, { asc }) => [asc(s.createdAt)],
      }) as Promise<ConnectedServer[]>;
    },

    /**
     * Batch id → display name, for naming servers in list responses. Falls back
     * to the SSH host, which is what an unnamed server is called everywhere else.
     */
    async listNamesByIds(ids: string[]): Promise<{ id: string; name: string }[]> {
      if (ids.length === 0) return [];
      return db
        .select({ id: servers.id, name: sql<string>`coalesce(${servers.name}, ${servers.sshHost})` })
        .from(servers)
        .where(inArray(servers.id, ids));
    },

    /** Ids of servers in an org whose name or SSH host matches a search term. */
    async searchIdsByName(organizationId: string, term: string, limit = 200): Promise<string[]> {
      const pattern = `%${term}%`;
      const rows = await db
        .select({ id: servers.id })
        .from(servers)
        .where(
          and(
            eq(servers.organizationId, organizationId),
            sql`(${servers.name} ILIKE ${pattern} OR ${servers.sshHost} ILIKE ${pattern})`,
          ),
        )
        .limit(limit);
      return rows.map((r) => r.id);
    },

    /**
     * Org-scoped inventory. Host-maintenance callers keep the connected-only
     * default; the shared management API explicitly includes managed servers.
     * NULL-org rows are never returned.
     */
    async listByOrganization<IncludeManaged extends boolean = false>(
      organizationId: string,
      includeManaged?: IncludeManaged,
    ): Promise<IncludeManaged extends true ? Server[] : ConnectedServer[]> {
      const rows = await db.query.servers.findMany({
        where: and(
          eq(servers.organizationId, organizationId),
          eq(servers.purpose, "deployment"),
          includeManaged ? undefined : isNull(servers.workspaceId),
        ),
        orderBy: (s, { asc }) => [asc(s.createdAt)],
      });
      return rows as IncludeManaged extends true ? Server[] : ConnectedServer[];
    },

    /** Sources live only in the import flow, never in host maintenance or defaults. */
    async listMigrationSources(organizationId: string): Promise<Server[]> {
      return db.query.servers.findMany({
        where: and(eq(servers.organizationId, organizationId), eq(servers.purpose, "migration_source")),
        orderBy: (s, { asc }) => [asc(s.createdAt)],
      });
    },

    /** Org-scoped get. Strict equality — NULL-org rows are invisible. */
    async getInOrganization(id: string, organizationId: string): Promise<Server | undefined> {
      return db.query.servers.findFirst({
        where: and(eq(servers.id, id), eq(servers.organizationId, organizationId)),
      });
    },

    /** The sole execution identity owned by a managed workspace. */
    async findByWorkspace(workspaceId: string, organizationId: string): Promise<Server | undefined> {
      return db.query.servers.findFirst({
        where: and(eq(servers.workspaceId, workspaceId), eq(servers.organizationId, organizationId)),
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
        // Deterministic: if more than one row was ever flagged local (a boot
        // reconcile row + an adopted/self-healed one), always return the oldest —
        // the canonical "This Server" — never an arbitrary pick.
        orderBy: (s, { asc }) => asc(s.createdAt),
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
      const server = await db.query.servers.findFirst({ where: eq(servers.id, id) });
      if (server?.workspaceId) throw new AppError(
        "Delete this managed host through its Cloud workspace", 409, "MANAGED_SERVER_LIFECYCLE_REQUIRED");
      await db.delete(servers).where(and(eq(servers.id, id), isNull(servers.workspaceId)));
    },
  };
}
