import { lt, eq } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { githubInstallState } from "../schema";
import type { GithubInstallStatePayload } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GithubInstallState = typeof githubInstallState.$inferSelect;
export type NewGithubInstallState = typeof githubInstallState.$inferInsert;

export interface CreateInstallStateInput {
  state: string;
  userId: string;
  organizationId: string | null;
  sourceId?: string | null;
  flow?: "install" | "manifest";
  payload?: GithubInstallStatePayload;
  /** Absolute expiry. The flow caller picks the window (typically 10min). */
  expiresAt: Date;
}

// ─── Repository ──────────────────────────────────────────────────────────────

export function createGithubInstallStateRepo(db: Database) {
  return {
    /**
     * INSERT a single-use state binding. Idempotent — on the astronomically
     * unlikely state-nonce collision (192 bits of entropy by convention),
     * the existing row is left alone so we never silently rebind a state
     * to a different user.
     */
    async create(input: CreateInstallStateInput): Promise<void> {
      await db
        .insert(githubInstallState)
        .values({
          id: generateId("gis"),
          state: input.state,
          userId: input.userId,
          organizationId: input.organizationId,
          sourceId: input.sourceId ?? null,
          flow: input.flow ?? "install",
          payload: input.payload ?? {},
          expiresAt: input.expiresAt,
        })
        .onConflictDoNothing({ target: githubInstallState.state });
    },

    /**
     * Look up a binding without consuming it. Returns null when the row
     * is missing or expired. Use this when verifying the install-complete
     * webhook before doing the DELETE in `consume` — read separately so
     * a verification failure leaves the row in place for an operator to
     * audit, instead of silently erasing the evidence.
     */
    async find(state: string): Promise<GithubInstallState | null> {
      const row = await db.query.githubInstallState.findFirst({
        where: eq(githubInstallState.state, state),
      });
      if (!row) return null;
      if (row.expiresAt < new Date()) return null;
      return row;
    },

    /**
     * Atomically consume a binding: DELETE + RETURNING in one statement.
     * Returns the row when it existed AND was not expired; null otherwise.
     * Use this on the success path (state verified to match the caller)
     * so re-replay of the same state cannot ride a second time.
     */
    async consume(state: string): Promise<GithubInstallState | null> {
      const rows = await db
        .delete(githubInstallState)
        .where(eq(githubInstallState.state, state))
        .returning();
      const row = rows[0];
      if (!row) return null;
      if (row.expiresAt < new Date()) return null;
      return row;
    },

    /**
     * Drop a binding without checking expiry — used to clean up after a
     * mismatched caller (state was found but the user/org didn't match)
     * so the offending nonce can't be retried.
     */
    async remove(state: string): Promise<void> {
      await db.delete(githubInstallState).where(eq(githubInstallState.state, state));
    },

    /** Drop expired rows. Called lazily on each create. */
    async purgeExpired(): Promise<number> {
      const now = new Date();
      const deleted = await db
        .delete(githubInstallState)
        .where(lt(githubInstallState.expiresAt, now))
        .returning();
      return deleted.length;
    },
  };
}
