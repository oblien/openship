import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { expireCookie, setSessionCookie } from "better-auth/cookies";

/** Server-side transport for sessions created by an authenticated local/Cloud
 * bridge. Better Auth owns signing, cookie policy and replacement of cached
 * identity. This endpoint has no HTTP route.
 */
export function sessionBridge() {
  return {
    id: "openship-session-bridge",
    hooks: {
      before: [
        {
          matcher: (ctx: { headers?: Headers; request?: Request }) =>
            /^Bearer /i.test(
              ctx.request?.headers.get("authorization") ?? ctx.headers?.get("authorization") ?? "",
            ),
          handler: createAuthMiddleware(async (ctx) => {
            // Session bearers retain their issued lifetime (including temporary
            // local CLI sessions). Keep browser renewal unchanged by overriding
            // only this request's Better Auth session options.
            ctx.context.options = {
              ...ctx.context.options,
              session: { ...ctx.context.options.session, disableSessionRefresh: true },
            };
          }),
        },
      ],
    },
    endpoints: {
      setBridgeSessionCookie: createAuthEndpoint.serverOnly({ method: "POST" }, async (ctx) => {
        const identity = await getSessionFromCtx(ctx, {
          disableCookieCache: true,
          disableRefresh: true,
        });
        if (!identity) throw new APIError("UNAUTHORIZED");
        expireCookie(ctx, ctx.context.authCookies.dontRememberToken);
        await setSessionCookie(ctx, identity, false, {
          maxAge: Math.max(
            0,
            Math.floor((identity.session.expiresAt.getTime() - Date.now()) / 1000),
          ),
        });
        return { ok: true };
      }),
    },
  };
}
