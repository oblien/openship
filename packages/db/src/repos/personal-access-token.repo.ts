import { and, desc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import {
  generateId,
  serializeSourceAccessScope,
  type Permission,
  type ResourceType,
  type SourceAccessScope,
} from "@repo/core";
import type { Database } from "../client";
import { personalAccessToken, personalAccessTokenGrant } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type PersonalAccessToken = typeof personalAccessToken.$inferSelect;
export type NewPersonalAccessToken = typeof personalAccessToken.$inferInsert;
/** A token row with the secret hash projected out — safe to hand to callers. */
export type PublicPersonalAccessToken = Omit<PersonalAccessToken, "tokenHash">;

export interface CreatePatInput {
  userId: string;
  organizationId: string | null;
  name: string;
  tokenPrefix: string;
  /** SHA-256 hex of the full token. Plaintext is never stored. */
  tokenHash: string;
  readOnly: boolean;
  /** True when the token carries its own resource grants (see patGrant repo). */
  scoped?: boolean;
  expiresAt: Date | null;
}

// ─── Repository ──────────────────────────────────────────────────────────────

export function createPersonalAccessTokenRepo(db: Database) {
  return {
    async create(input: CreatePatInput): Promise<PersonalAccessToken> {
      const [row] = await db
        .insert(personalAccessToken)
        .values({
          id: generateId("pat"),
          userId: input.userId,
          organizationId: input.organizationId,
          name: input.name,
          tokenPrefix: input.tokenPrefix,
          tokenHash: input.tokenHash,
          readOnly: input.readOnly,
          scoped: input.scoped ?? false,
          expiresAt: input.expiresAt,
        })
        .returning();
      return row!;
    },

    /**
     * Resolve an ACTIVE token by the SHA-256 hash of the presented secret.
     * Returns null when missing, revoked, or expired. Lookup is by the full
     * hash (unique-indexed) — the secret carries full entropy, so equality on
     * the hash leaks nothing exploitable.
     */
    async findActiveByHash(tokenHash: string): Promise<PersonalAccessToken | null> {
      const row = await db.query.personalAccessToken.findFirst({
        where: eq(personalAccessToken.tokenHash, tokenHash),
      });
      if (!row) return null;
      if (row.revokedAt) return null;
      if (row.expiresAt && row.expiresAt < new Date()) return null;
      return row;
    },

    /**
     * List a user's MANUAL tokens (newest first). OAuth MCP client bindings
     * (`oauthClientId` set) are excluded — they're grant-holders, not
     * user-facing tokens. The `tokenHash` column is projected out at the query
     * level, so the secret hash never leaves the repo.
     */
    async listByUser(userId: string): Promise<PublicPersonalAccessToken[]> {
      return db.query.personalAccessToken.findMany({
        columns: { tokenHash: false },
        where: and(
          eq(personalAccessToken.userId, userId),
          isNull(personalAccessToken.oauthClientId),
        ),
        orderBy: [desc(personalAccessToken.createdAt)],
      });
    },

    /**
     * List a user's OAuth MCP client bindings (the "connected clients" the
     * settings UI shows). Only active bindings — a disconnected one is
     * hard-deleted. `tokenHash` is projected out (it's a synthetic sentinel
     * anyway, but the projection keeps the contract uniform).
     */
    async listOAuthBindings(userId: string): Promise<PublicPersonalAccessToken[]> {
      return db.query.personalAccessToken.findMany({
        columns: { tokenHash: false },
        where: and(
          eq(personalAccessToken.userId, userId),
          isNotNull(personalAccessToken.oauthClientId),
          isNull(personalAccessToken.revokedAt),
        ),
        orderBy: [desc(personalAccessToken.createdAt)],
      });
    },

    /**
     * Display names for a set of token ids. Used to label audit rows attributed
     * to `pat:<tokenId>` — a static-token MCP connection has no OAuth application
     * to read a name from, so the token's own name is the only label there is.
     *
     * Deliberately NOT user-scoped: the caller is reading rows in an org it holds
     * audit:read on, and a token used against that org is part of its history even
     * if it belongs to another member. Only the name is projected.
     */
    async listNamesByIds(ids: string[]): Promise<Array<{ id: string; name: string }>> {
      if (ids.length === 0) return [];
      return db
        .select({ id: personalAccessToken.id, name: personalAccessToken.name })
        .from(personalAccessToken)
        .where(inArray(personalAccessToken.id, ids));
    },

    /**
     * The grant-holder row for an OAuth MCP client binding, keyed by
     * (userId, oauthClientId). Returns null (never revoked/expired-filtered —
     * a binding has no expiry) if the client hasn't been authorized yet.
     */
    async findOAuthBinding(userId: string, oauthClientId: string): Promise<PersonalAccessToken | null> {
      const row = await db.query.personalAccessToken.findFirst({
        where: and(
          eq(personalAccessToken.userId, userId),
          eq(personalAccessToken.oauthClientId, oauthClientId),
          // Honor revocation for parity with findActiveByHash / listOAuthBindings —
          // a revoked binding must NOT resolve, or a torn-down client keeps access.
          isNull(personalAccessToken.revokedAt),
        ),
      });
      return row ?? null;
    },

    /**
     * Create-or-update the grant-holder for an OAuth MCP client binding AND replace
     * its resource grants, in one transaction.
     *
     * The two writes must not be separable. Done as upsert-then-delete-then-insert
     * across two awaits, a failure in the window leaves the binding `scoped: true`
     * holding ZERO grants — which is deny-all. At first consent that is merely a
     * client that never worked; on a re-scope it is a live agent that silently lost
     * all access mid-save. `oauth.repo.disconnectMcpClient` already spans both
     * tables for the same reason.
     *
     * `unrevoke` is deliberately a parameter rather than always-true: a fresh
     * consent IS a new authorization and should clear `revokedAt`, but an edit to an
     * existing binding must never resurrect one that was revoked out from under it.
     */
    async upsertOAuthBindingWithGrants(input: {
      userId: string;
      organizationId: string | null;
      oauthClientId: string;
      readOnly: boolean;
      scoped: boolean;
      unrevoke: boolean;
      grants: ReadonlyArray<{
        resourceType: ResourceType;
        resourceId: string;
        permissions: Permission[];
        scope?: SourceAccessScope | null;
      }>;
    }): Promise<PersonalAccessToken> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(personalAccessToken)
          .values({
            id: generateId("pat"),
            userId: input.userId,
            organizationId: input.organizationId,
            oauthClientId: input.oauthClientId,
            name: `MCP client ${input.oauthClientId}`,
            // Binding rows are never presented as a bearer — a random, unique,
            // non-guessable hash keeps the unique constraint happy and can never
            // collide with a real token's SHA-256 hash.
            tokenPrefix: "mcp-oauth",
            tokenHash: `oauth-binding:${generateId("patbind")}`,
            readOnly: input.readOnly,
            scoped: input.scoped,
          })
          .onConflictDoUpdate({
            target: [personalAccessToken.userId, personalAccessToken.oauthClientId],
            set: {
              organizationId: input.organizationId,
              readOnly: input.readOnly,
              scoped: input.scoped,
              ...(input.unrevoke ? { revokedAt: null } : {}),
            },
          })
          .returning();
        const binding = row!;

        // Wholesale replacement: re-authorizing overwrites. The binding id is stable
        // across the upsert, so issued OAuth tokens keep resolving to it.
        await tx
          .delete(personalAccessTokenGrant)
          .where(eq(personalAccessTokenGrant.tokenId, binding.id));

        if (input.scoped && input.grants.length > 0) {
          await tx.insert(personalAccessTokenGrant).values(
            input.grants.map((g) => ({
              id: generateId("patgrant"),
              tokenId: binding.id,
              resourceType: g.resourceType,
              resourceId: g.resourceId,
              permissionsJson: JSON.stringify(g.permissions),
              // Normalized on write so a pattern the matcher would reject is never
              // stored as though it were enforceable.
              scopeJson: serializeSourceAccessScope(g.scope ?? undefined),
            })),
          );
        }

        return binding;
      });
    },

    /** Revoke one of the user's own tokens. Returns false if not found/already revoked. */
    async revoke(id: string, userId: string): Promise<boolean> {
      const rows = await db
        .update(personalAccessToken)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(personalAccessToken.id, id),
            eq(personalAccessToken.userId, userId),
            isNull(personalAccessToken.revokedAt),
            // Only manual PATs. An OAuth-binding row is a personal_access_token
            // too, but tearing it down must go through disconnectMcpClient
            // (deletes the better-auth token + consent + binding + grants atomically);
            // soft-revoking it here would leave the token live but the client hidden.
            isNull(personalAccessToken.oauthClientId),
          ),
        )
        .returning();
      return rows.length > 0;
    },

    /**
     * Best-effort usage stamp (called on each authenticated request).
     *
     * The counter rides along in the same UPDATE — it is the same row and the same
     * write, so "how many calls has this agent made" costs nothing on top of "when
     * did it last call". Incremented in SQL, not read-modify-write, so concurrent
     * requests from one agent don't lose counts.
     */
    async touchLastUsed(id: string): Promise<void> {
      await db
        .update(personalAccessToken)
        .set({ lastUsedAt: new Date(), useCount: sql`${personalAccessToken.useCount} + 1` })
        .where(eq(personalAccessToken.id, id));
    },
  };
}
