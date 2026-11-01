import { lt, eq, and, gt, or, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { githubInstallState, userSettings } from "../schema";
import type { GithubInstallStatePayload } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GithubInstallState = typeof githubInstallState.$inferSelect;
export type NewGithubInstallState = typeof githubInstallState.$inferInsert;

export interface CreateInstallStateInput {
  state: string;
  userId: string;
  organizationId: string | null;
  sourceId?: string | null;
  flow?: "install" | "manifest" | "repository-oauth";
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
     * is missing, expired, or terminal. Verification reads this first;
     * claimWithState atomically completes it with the installation write.
     */
    async find(state: string): Promise<GithubInstallState | null> {
      const row = await db.query.githubInstallState.findFirst({
        where: eq(githubInstallState.state, state),
      });
      if (!row) return null;
      if (row.expiresAt < new Date()) return null;
      if (["complete", "pending-approval", "failed"].includes(row.flow)) return null;
      return row;
    },

    /** Report this exact attempt, scoped to its initiating user and workspace. */
    async progress(state: string, userId: string, organizationId: string): Promise<{
      status: "waiting" | "complete" | "pending-approval" | "expired" | "failed"; error?: string;
    }> {
      const row = await db.query.githubInstallState.findFirst({ where: and(
        eq(githubInstallState.state, state), eq(githubInstallState.userId, userId),
        eq(githubInstallState.organizationId, organizationId), gt(githubInstallState.expiresAt, new Date()),
      ) });
      if (!row) return { status: "expired" };
      if (row.flow === "complete" || row.flow === "pending-approval") return { status: row.flow };
      if (row.payload.connectionError) return { status: "failed", error: row.payload.connectionError };
      return { status: row.flow === "install" || row.flow === "repository-oauth" ? "waiting" : "expired" };
    },

    async recordFailure(state: string, userId: string, organizationId: string, error: string): Promise<void> {
      await db.update(githubInstallState).set({ payload: sql`${githubInstallState.payload} || ${JSON.stringify({ connectionError: error })}::jsonb` }).where(and(
        eq(githubInstallState.state, state), eq(githubInstallState.userId, userId),
        eq(githubInstallState.organizationId, organizationId), eq(githubInstallState.flow, "install"),
      ));
    },

    /** OAuth failures are terminal; another attempt must obtain fresh proof. */
    async failAuthorization(state: string, userId: string, error: string): Promise<void> {
      await db.update(githubInstallState).set({ flow: "failed", payload: { connectionError: error } }).where(and(
        eq(githubInstallState.state, state), eq(githubInstallState.userId, userId),
        eq(githubInstallState.flow, "repository-oauth"),
      ));
    },

    async pendingApproval(state: string, userId: string, organizationId: string): Promise<boolean> {
      const rows = await db.update(githubInstallState).set({ flow: "pending-approval", payload: {} }).where(and(
        eq(githubInstallState.state, state), eq(githubInstallState.userId, userId),
        eq(githubInstallState.organizationId, organizationId), eq(githubInstallState.flow, "install"),
        gt(githubInstallState.expiresAt, new Date()),
      )).returning();
      return rows.length === 1;
    },

    /** One browser can begin OAuth; the original nonce remains observable. */
    async beginAuthorization(state: string, userId: string, organizationId: string, payload: GithubInstallStatePayload): Promise<boolean> {
      const rows = await db.update(githubInstallState).set({ flow: "repository-oauth", payload })
        .where(and(eq(githubInstallState.state, state), eq(githubInstallState.userId, userId),
          eq(githubInstallState.organizationId, organizationId), eq(githubInstallState.flow, "install"),
          gt(githubInstallState.expiresAt, new Date()),
        )).returning();
      return rows.length === 1;
    },

    /** Save the grant and advance to installation selection in one transaction. */
    async completeAuthorization(state: string, userId: string, encrypted: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const rows = await tx.update(githubInstallState).set({ flow: "install", payload: sql`${githubInstallState.payload} - 'codeVerifierEncrypted' - 'browserNonceHash' - 'callbackMode' - 'connectionError'` })
          .where(and(eq(githubInstallState.state, state), eq(githubInstallState.userId, userId),
            eq(githubInstallState.flow, "repository-oauth"), gt(githubInstallState.expiresAt, new Date()),
          )).returning();
        if (!rows.length) return false;
        await tx.insert(userSettings).values({ id: generateId(), userId, githubAuthorizationEncrypted: encrypted })
          .onConflictDoUpdate({ target: userSettings.userId, set: {
            githubAuthorizationEncrypted: encrypted, updatedAt: new Date(),
          } });
        return true;
      });
    },

    async cancelAuthorizations(userId: string, disconnectedGrant: string): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.delete(githubInstallState).where(and(eq(githubInstallState.userId, userId),
          or(eq(githubInstallState.flow, "repository-oauth"), eq(githubInstallState.flow, "install")),
        ));
        await tx.insert(userSettings).values({ id: generateId(), userId, githubAuthorizationEncrypted: disconnectedGrant })
          .onConflictDoUpdate({ target: userSettings.userId, set: {
            githubAuthorizationEncrypted: disconnectedGrant, updatedAt: new Date(),
          } });
      });
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
