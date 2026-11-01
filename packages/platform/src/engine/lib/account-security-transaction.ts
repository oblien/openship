import type { BetterAuthPlugin, GenericEndpointContext } from "@better-auth/core";
import { runWithAdapter } from "@better-auth/core/context";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { and, eq, gt, schema, type Database } from "@repo/db/factory";

type Endpoint = NonNullable<BetterAuthPlugin["endpoints"]>[string];

/**
 * Keep the framework's verification and credential writes in one DB transaction.
 * Lock the account before reading mutable security state, including across Cloud
 * replicas. The account lookup only selects a lock; the original endpoint still
 * validates the session, challenge, password, credential ownership and code.
 */
export function atomicSecurityEndpoint<T extends Endpoint>(
  database: Database,
  endpoint: T,
  before?: (ctx: GenericEndpointContext) => Promise<void>,
): T {
  const wrapped = createAuthEndpoint(
    endpoint.path,
    // Run the original endpoint's session middleware again after acquiring the
    // row lock. A request waiting for another change must not keep stale state.
    { ...endpoint.options, use: undefined },
    async (ctx: GenericEndpointContext) => {
      const original = ctx.context.adapter;
      try {
        const result = await database.transaction(async (tx) => {
          const adapter = drizzleAdapter(tx, { provider: "pg", schema })(ctx.context.options);
          return runWithAdapter(adapter, async () => {
            ctx.context.adapter = adapter;
            ctx.context.session = null;
            const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
            let userId = session?.user.id;
            if (ctx.path === "/passkey/verify-authentication") {
              // Sign-in can replace an existing account's session. Serialize on
              // the credential owner, never on that previous signed-in account.
              const credentialId = ctx.body?.response?.id;
              if (typeof credentialId === "string") {
                const [credential] = await tx
                  .select({ userId: schema.passkey.userId })
                  .from(schema.passkey)
                  .where(eq(schema.passkey.credentialID, credentialId))
                  .limit(1);
                userId = credential?.userId;
              }
            } else if (!userId && ctx.path?.startsWith("/two-factor/")) {
              const cookie = ctx.context.createAuthCookie("two_factor");
              const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
              if (identifier) {
                const [challenge] = await tx
                  .select({ userId: schema.verification.value })
                  .from(schema.verification)
                  .where(
                    and(
                      eq(schema.verification.identifier, identifier),
                      gt(schema.verification.expiresAt, new Date()),
                    ),
                  )
                  .limit(1);
                userId = challenge?.userId;
              }
            }
            if (userId) {
              await tx
                .select({ id: schema.user.id })
                .from(schema.user)
                .where(eq(schema.user.id, userId))
                .for("update");
            }
            ctx.context.session = null;
            await before?.(ctx);
            return endpoint({ ...ctx, asResponse: false, returnHeaders: true, returnStatus: true });
          });
        });
        // A rolled-back change must not send a new session cookie or bearer token.
        // Better Call owns this header collection at runtime. Append Set-Cookie
        // separately: setHeader replaces earlier cookies in a rotation response.
        const headers = (ctx as GenericEndpointContext & { responseHeaders: Headers })
          .responseHeaders;
        result.headers.forEach((value: string, key: string) => {
          if (key.toLowerCase() === "set-cookie") headers.append(key, value);
          else headers.set(key, value);
        });
        ctx.setStatus(result.status);
        return result.response;
      } catch (error) {
        ctx.context.newSession = null;
        throw error;
      } finally {
        ctx.context.adapter = original;
      }
    },
  );
  // Same endpoint schema and response; only execution and commit timing change.
  return wrapped as unknown as T;
}
