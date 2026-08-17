/**
 * Organization repo — reads on Better Auth's `organization` table.
 *
 * Better Auth's organization plugin owns the WRITE path for the columns
 * IT manages (id, name, slug, logo, metadata, createdAt). For our own
 * columns on the same table — currently just `is_team` — we read AND
 * write here. The plugin's queries select specific columns and ignore
 * extras, so this is safe.
 *
 * Keep plugin-managed writes off this repo — go through
 * `auth.api.createOrganization`/`updateOrganization` instead so the
 * plugin's invariants and audit hooks stay correct.
 */

import { eq, inArray } from "drizzle-orm";
import type { Database } from "../client";
import { organization } from "../schema/organization";

export type Organization = typeof organization.$inferSelect;

export function createOrganizationRepo(db: Database) {
  return {
    /** Lookup by primary key. Returns null on miss. */
    async findById(id: string): Promise<Organization | null> {
      const [row] = await db
        .select()
        .from(organization)
        .where(eq(organization.id, id))
        .limit(1);
      return row ?? null;
    },

    /**
     * Bulk lookup — used to enrich a list of org ids in one round
     * trip. Single SQL `WHERE id IN (...)` query, no full-table scan.
     */
    async findManyById(ids: string[]): Promise<Organization[]> {
      if (ids.length === 0) return [];
      return db
        .select()
        .from(organization)
        .where(inArray(organization.id, ids));
    },

    /**
     * True iff the org is in "team mode" — i.e. invites are allowed
     * and the role/grants UI is shown. Personal workspaces (default,
     * isTeam=false) reject invite-member calls.
     */
    async isTeam(id: string): Promise<boolean> {
      const row = await this.findById(id);
      return row?.isTeam === true;
    },

    /** Flip the team-mode flag. Used by /create-team-org. */
    async setIsTeam(id: string, isTeam: boolean): Promise<void> {
      await db
        .update(organization)
        .set({ isTeam })
        .where(eq(organization.id, id));
    },
  };
}
