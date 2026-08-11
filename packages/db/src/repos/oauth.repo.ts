import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../client";
import { oauthApplication, oauthAccessToken, oauthConsent, personalAccessToken } from "../schema";
import { personalAccessTokenGrant } from "../schema/personal-access-token-grant";

/**
 * Read + revocation access to the Better Auth OAuth tables.
 *
 * The plugin OWNS creation of these rows (see schema/oauth.ts) — we never
 * insert or update. The only writes here are DELETEs for a user-initiated
 * "disconnect this MCP client": there's no Better Auth API to revoke a user's
 * issued tokens/consent for a client, so we drop the rows directly. Reads back
 * the client's display name for the "connected clients" list.
 */
export function createOAuthRepo(db: Database) {
  return {
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
