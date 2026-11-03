import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, desc, gt, lt, isNull, or } from "drizzle-orm";
import type { Database } from "../client";
import type { Encryption } from "../encryption";
import {
  oauthClient,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  mcpOAuthToken,
  session,
  personalAccessToken,
  personalAccessTokenGrant,
} from "../schema";

const digest = (token: string) => createHash("sha256").update(token).digest("base64url");

/** Provider grants stay in Better Auth; encrypted receipts support host-side connections. */
export function createOAuthRepo(db: Database, encryption: Pick<Encryption, "encrypt" | "decrypt">) {
  return {
    async recordIssuedToken(input: {
      accessToken: string;
      refreshToken?: string;
      userId: string;
      clientId: string;
      sessionId: string;
      scopes: string;
      accessTokenExpiresAt: Date;
    }) {
      const [refresh] = input.refreshToken
        ? await db
            .select()
            .from(oauthRefreshToken)
            .where(
              and(
                eq(oauthRefreshToken.token, digest(input.refreshToken)),
                eq(oauthRefreshToken.userId, input.userId),
                eq(oauthRefreshToken.clientId, input.clientId),
              ),
            )
            .limit(1)
        : [];
      if (input.refreshToken && (!refresh || refresh.revoked))
        throw new Error("Missing OAuth refresh grant");
      await db
        .insert(mcpOAuthToken)
        .values({
          id: randomUUID(),
          accessTokenHash: digest(input.accessToken),
          accessTokenEncrypted: encryption.encrypt(input.accessToken),
          refreshTokenEncrypted: input.refreshToken ? encryption.encrypt(input.refreshToken) : null,
          accessTokenExpiresAt: input.accessTokenExpiresAt,
          refreshTokenExpiresAt: refresh?.expiresAt ?? null,
          clientId: input.clientId,
          userId: input.userId,
          sessionId: input.sessionId,
          refreshId: refresh?.id ?? null,
          scopes: input.scopes,
        })
        .onConflictDoNothing({ target: mcpOAuthToken.accessTokenHash });
      await db
        .delete(mcpOAuthToken)
        .where(
          and(
            eq(mcpOAuthToken.userId, input.userId),
            eq(mcpOAuthToken.clientId, input.clientId),
            lt(mcpOAuthToken.accessTokenExpiresAt, new Date()),
          ),
        );
    },

    /** Host-side credentials only; never serialize this return value to an API client. */
    async findClientToken(userId: string, clientId: string) {
      const [row] = await db
        .select()
        .from(mcpOAuthToken)
        .where(and(eq(mcpOAuthToken.userId, userId), eq(mcpOAuthToken.clientId, clientId)))
        .orderBy(desc(mcpOAuthToken.createdAt))
        .limit(1);
      if (!row) return undefined;
      return {
        ...row,
        accessToken: encryption.decrypt(row.accessTokenEncrypted),
        refreshToken: row.refreshTokenEncrypted
          ? encryption.decrypt(row.refreshTokenEncrypted)
          : null,
      };
    },

    /** Exact issued-token lookup, including live session/client/grant revocation. */
    async findAccessToken(accessToken: string) {
      const [row] = await db
        .select({
          id: mcpOAuthToken.id,
          userId: mcpOAuthToken.userId,
          clientId: mcpOAuthToken.clientId,
          scopes: mcpOAuthToken.scopes,
          accessTokenExpiresAt: mcpOAuthToken.accessTokenExpiresAt,
        })
        .from(mcpOAuthToken)
        .innerJoin(session, eq(session.id, mcpOAuthToken.sessionId))
        .innerJoin(oauthClient, eq(oauthClient.clientId, mcpOAuthToken.clientId))
        .leftJoin(oauthRefreshToken, eq(oauthRefreshToken.id, mcpOAuthToken.refreshId))
        .where(
          and(
            eq(mcpOAuthToken.accessTokenHash, digest(accessToken)),
            gt(mcpOAuthToken.accessTokenExpiresAt, new Date()),
            gt(session.expiresAt, new Date()),
            or(isNull(oauthClient.disabled), eq(oauthClient.disabled, false)),
            isNull(oauthRefreshToken.revoked),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async listApplicationsByClientIds(
      clientIds: string[],
    ): Promise<Array<{ clientId: string; name: string }>> {
      if (!clientIds.length) return [];
      const rows = await db
        .select({ clientId: oauthClient.clientId, name: oauthClient.name })
        .from(oauthClient)
        .where(inArray(oauthClient.clientId, clientIds));
      return rows.map((row) => ({ ...row, name: row.name ?? "MCP client" }));
    },

    /** Delete provider grants and receipts together with the user's scope binding. */
    async disconnectMcpClient(userId: string, clientId: string): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .delete(mcpOAuthToken)
          .where(and(eq(mcpOAuthToken.userId, userId), eq(mcpOAuthToken.clientId, clientId)));
        await tx
          .delete(oauthAccessToken)
          .where(and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, clientId)));
        await tx
          .delete(oauthRefreshToken)
          .where(
            and(eq(oauthRefreshToken.userId, userId), eq(oauthRefreshToken.clientId, clientId)),
          );
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
        for (const binding of bindings) {
          await tx
            .delete(personalAccessTokenGrant)
            .where(eq(personalAccessTokenGrant.tokenId, binding.id));
        }
      });
    },
  };
}
