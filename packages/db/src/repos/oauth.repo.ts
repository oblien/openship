import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../client";
import { oauthApplication, oauthAccessToken, oauthConsent, personalAccessToken } from "../schema";
import { personalAccessTokenGrant } from "../schema/personal-access-token-grant";

/**
 * Read + revocation access to the Better Auth OAuth tables.
 *
 * The plugin OWNS creation of these rows (see schema/oauth.ts) — we never
 * insert. The only writes here are DELETEs for a user-initiated "disconnect
 * this MCP client" (there's no Better Auth API to revoke a user's issued
 * tokens/consent for a client, so we drop the rows directly), plus the
 * audience-rebind UPDATE described on `rebindAccessToken`. Reads back the
 * client's display name for the "connected clients" list.
 */
export function createOAuthRepo(db: Database) {
  return {
    /** The issued-token row for an access token string, or null. */
    async findAccessToken(accessToken: string): Promise<{
      id: string;
      userId: string | null;
      clientId: string;
      scopes: string;
      accessTokenExpiresAt: Date;
    } | null> {
      const [row] = await db
        .select({
          id: oauthAccessToken.id,
          userId: oauthAccessToken.userId,
          clientId: oauthAccessToken.clientId,
          scopes: oauthAccessToken.scopes,
          accessTokenExpiresAt: oauthAccessToken.accessTokenExpiresAt,
        })
        .from(oauthAccessToken)
        .where(eq(oauthAccessToken.accessToken, accessToken))
        .limit(1);
      return row ?? null;
    },

    /**
     * Swap an issued access token's stored string. Used ONLY by the MCP token
     * endpoint to replace the plugin's opaque value with the audience-bound JWT
     * handed to the client (see lib/mcp-token.ts) — introspection stays an
     * exact-string lookup either way. Returns false when the row is gone.
     */
    async rebindAccessToken(currentToken: string, nextToken: string): Promise<boolean> {
      const updated = await db
        .update(oauthAccessToken)
        .set({ accessToken: nextToken, updatedAt: new Date() })
        .where(eq(oauthAccessToken.accessToken, currentToken))
        .returning();
      return updated.length > 0;
    },

    /** Display metadata (clientId → name) for a set of client_ids. */
    async listApplicationsByClientIds(
      clientIds: string[],
    ): Promise<Array<{ clientId: string; name: string }>> {
      if (clientIds.length === 0) return [];
      return db
        .select({ clientId: oauthApplication.clientId, name: oauthApplication.name })
        .from(oauthApplication)
        .where(inArray(oauthApplication.clientId, clientIds));
    },

    /**
     * Fully disconnect an MCP client for one user, atomically. Spans the OAuth
     * tables AND the scope binding (a personal_access_token row + its grants),
     * so it runs in a single transaction — a mid-way failure rolls back rather
     * than leaving a half-torn-down authorization.
     *
     * Order matters for the failure case even inside a tx: tokens are revoked
     * first, so the intent (kill access) is expressed up front. Steps:
     *   1. delete issued access/refresh tokens (client's bearer stops resolving)
     *   2. delete recorded consent (a reconnect re-prompts → new binding)
     *   3. delete the scope binding + its resource grants
     */
    async disconnectMcpClient(userId: string, clientId: string): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .delete(oauthAccessToken)
          .where(and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, clientId)));

        await tx
          .delete(oauthConsent)
          .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)));

        const bindings = await tx
          .delete(personalAccessToken)
          .where(
            and(
              eq(personalAccessToken.userId, userId),
              eq(personalAccessToken.oauthClientId, clientId),
            ),
          )
          .returning();

        const bindingId = bindings[0]?.id;
        if (bindingId) {
          await tx
            .delete(personalAccessTokenGrant)
            .where(eq(personalAccessTokenGrant.tokenId, bindingId));
        }
      });
    },
  };
}
