import { eq } from "drizzle-orm";
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

    /** Get a single server by ID */
    async get(id: string): Promise<Server | undefined> {
      return db.query.servers.findFirst({
        where: eq(servers.id, id),
      });
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
