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

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../client";
import { organization } from "../schema/organization";

export type Organization = typeof organization.$inferSelect;

export function createOrganizationRepo(db: Database) {
  return {
    async findBySlug(slug: string): Promise<Organization | null> {
      const [row] = await db.select().from(organization).where(eq(organization.slug, slug)).limit(1);
      return row ?? null;
    },

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

    /**
     * Update the openship-internal subscription status. Used by the
     * hard-cap handler to flip between `active` and `credit_exhausted`
     * when usage outruns balance, and by the Stripe webhook handler for
     * Stripe-driven transitions (`past_due`, `canceled`, `trialing`).
     */
    async setSubscriptionStatus(id: string, status: string): Promise<void> {
      await db
        .update(organization)
        .set({ subscriptionStatus: status })
        .where(eq(organization.id, id));
    },

    /** Mirror an authoritative Oblien entitlement without changing its quota. */
    async setBillingEntitlement(id: string, namespace: string, input: {
      planTierId: string;
      subscriptionStatus: string;
      currentPeriodStart: Date | null;
      currentPeriodEnd: Date | null;
    }): Promise<void> {
      const rows = await db.update(organization).set(input)
        .where(and(eq(organization.id, id), eq(organization.oblienNamespace, namespace)))
        .returning();
      if (rows.length !== 1) throw new Error("Organization namespace changed during billing synchronization");
    },

    /**
     * Record the org's Oblien namespace slug.
     *
     * This column was read in eleven places and written in NONE, which made the
     * entire Oblien entitlement path inert: every quota helper opens with
     * `if (!org.oblienNamespace) return`, so `setQuota`, `addQuota`,
     * `resetAndRegrant` and `applyResourceLimits` were no-ops, namespaces ran
     * with no ceiling at all, and the `credits.usage` webhook — which matches
     * deliveries on this column — dropped every event. Nothing about that failure
     * was visible: each function returned successfully.
     */
    async setOblienNamespace(id: string, namespace: string): Promise<void> {
      const rows = await db
        .update(organization)
        .set({ oblienNamespace: namespace })
        .where(and(eq(organization.id, id), isNull(organization.oblienNamespace)))
        .returning();
      if (rows.length === 0) {
        const existing = await this.findById(id);
        if (existing?.oblienNamespace !== namespace) {
          throw new Error("Organization namespace cannot be reassigned");
        }
      }
    },

    /**
     * Orgs with no namespace recorded yet — the boot backfill's work list.
     * Bounded because this runs on every cloud boot and the tail of orgs that
     * predate namespace persistence only needs draining once.
     */
    async listWithoutOblienNamespace(limit = 200): Promise<{ id: string }[]> {
      return db
        .select({ id: organization.id })
        .from(organization)
        .where(isNull(organization.oblienNamespace))
        .limit(limit);
    },
  };
}
