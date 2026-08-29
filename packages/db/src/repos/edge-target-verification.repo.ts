import { and, eq } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { edgeTargetVerification } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type EdgeTargetVerification = typeof edgeTargetVerification.$inferSelect;
export type NewEdgeTargetVerification = typeof edgeTargetVerification.$inferInsert;

/** How many superseded tokens to keep serving. A re-request resets the token while an
 *  older record may still be probed, so the previous few must stay answerable — but
 *  this can't grow without bound either. */
const RETIRED_TOKEN_CAP = 10;

/** The minimal row shape `servableTokens` reads. */
type ServableTokenRow = { token?: string | null; retiredTokens?: string[] | null };

/** Every token a target must keep answering — current first, then retired. */
export function servableTokens(row: ServableTokenRow | undefined | null): string[] {
  if (!row) return [];
  return [...(row.token ? [row.token] : []), ...(row.retiredTokens ?? [])];
}

// ─── Repository ──────────────────────────────────────────────────────────────

export function createEdgeTargetVerificationRepo(db: Database) {
  return {
    /** The row for one org's target, if any. `target` must be the canonical string. */
    async findByTarget(
      organizationId: string,
      target: string,
    ): Promise<EdgeTargetVerification | undefined> {
      return db.query.edgeTargetVerification.findFirst({
        where: and(
          eq(edgeTargetVerification.organizationId, organizationId),
          eq(edgeTargetVerification.target, target),
        ),
      });
    },

    /** Every row for an org — used to re-assert tokens on a rebuilt box. */
    async listByOrganization(organizationId: string): Promise<EdgeTargetVerification[]> {
      return db.query.edgeTargetVerification.findMany({
        where: eq(edgeTargetVerification.organizationId, organizationId),
      });
    },

    /**
     * Every row on this installation, oldest first.
     *
     * For the periodic sweep, which is not scoped to an org: the thing being kept
     * alive is a box's ability to answer, and one box's targets can belong to
     * several orgs in team mode.
     */
    async listAll(): Promise<EdgeTargetVerification[]> {
      return db.query.edgeTargetVerification.findMany({
        orderBy: (t, { asc }) => [asc(t.createdAt)],
      });
    },

    /**
     * Record a freshly-issued challenge.
     *
     * Retires the row's PREVIOUS token rather than replacing it: the upstream may
     * still probe the old one until its record expires, and dropping it would fail a
     * verification that currently works. Nothing is ever removed on the delete side —
     * see the table comment on the 90-day re-probe.
     */
    async recordChallenge(
      data: Omit<NewEdgeTargetVerification, "id"> & { token: string },
    ): Promise<EdgeTargetVerification> {
      const existing = await this.findByTarget(data.organizationId, data.target);
      const retired = [
        ...(existing?.token && existing.token !== data.token ? [existing.token] : []),
        ...(existing?.retiredTokens ?? []),
      ]
        .filter((t, i, all) => t !== data.token && all.indexOf(t) === i)
        .slice(0, RETIRED_TOKEN_CAP);

      const [row] = await db
        .insert(edgeTargetVerification)
        .values({
          ...data,
          id: generateId("etv"),
          retiredTokens: retired,
          status: data.status ?? "pending",
        })
        .onConflictDoUpdate({
          target: [edgeTargetVerification.organizationId, edgeTargetVerification.target],
          set: {
            host: data.host,
            serverId: data.serverId ?? null,
            verificationId: data.verificationId ?? null,
            token: data.token,
            retiredTokens: retired,
            challengePath: data.challengePath ?? null,
            status: data.status ?? "pending",
            lastError: null,
            updatedAt: new Date(),
          },
        })
        .returning();
      return row;
    },

    /** Record the outcome of a check. */
    async recordCheck(
      id: string,
      outcome: {
        status: string;
        validatedIp?: string | null;
        expiresAt?: Date | null;
        lastError?: string | null;
      },
    ): Promise<void> {
      await db
        .update(edgeTargetVerification)
        .set({
          status: outcome.status,
          validatedIp: outcome.validatedIp ?? null,
          expiresAt: outcome.expiresAt ?? null,
          lastError: outcome.lastError ?? null,
          lastCheckedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(edgeTargetVerification.id, id));
    },

    /**
     * Record (or clear) a problem with SERVING the token, without touching `status`.
     *
     * Deliberately separate from `recordCheck`: the upstream owns `status`, and a box
     * that has temporarily lost its token file is still `verified` upstream until the
     * re-probe says otherwise. Flipping it here would report a route as dead while it
     * is still live, and would also reset `lastCheckedAt`, which gates re-attempts.
     */
    async recordServeError(id: string, error: string | null): Promise<void> {
      await db
        .update(edgeTargetVerification)
        .set({ lastError: error, updatedAt: new Date() })
        .where(eq(edgeTargetVerification.id, id));
    },

    servableTokens,
  };
}
