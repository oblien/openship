import { passkey } from "@better-auth/passkey";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  freshSessionMiddleware,
  getSessionFromCtx,
  setPassword,
} from "better-auth/api";
import { expireCookie } from "better-auth/cookies";
import { twoFactor } from "better-auth/plugins";
import { resolvePasskeyConfig } from "./passkey-config";

interface AccountSecurityOptions {
  dashboardUrl: string;
  getAuthMode: () => Promise<"none" | "local" | "cloud">;
}

/** Every primary sign-in that can issue a session in our Better Auth setup. */
function isPrimarySignIn(path: string | undefined) {
  if (!path) return false;
  return (
    path.startsWith("/sign-in/") ||
    path.startsWith("/callback/") ||
    path === "/passkey/verify-authentication" ||
    path === "/verify-email" ||
    path === "/email-otp/verify-email"
  );
}

/**
 * Keep WebAuthn, TOTP, encrypted secrets and recovery-code consumption in Better
 * Auth. Its default 2FA hook only covers password login; compose that same hook
 * over our other primary logins so OAuth and passkeys cannot skip an enabled 2FA.
 */
export function accountSecurityPlugins(options: AccountSecurityOptions) {
  const passkeys = passkey(resolvePasskeyConfig(options.dashboardUrl));
  const mfa = twoFactor({ issuer: "Openship" });
  const challenge = mfa.hooks.after[0]!;

  const factors = {
    ...mfa,
    endpoints: {
      ...mfa.endpoints,
      // Reuse the framework's server-only endpoint and sensitive-session
      // validation for OAuth-only users. Existing passwords cannot be replaced.
      setAccountPassword: createAuthEndpoint(
        "/account-security/set-password",
        { ...setPassword.options, use: [...setPassword.options.use, freshSessionMiddleware] },
        async (ctx) => setPassword({ ...ctx, asResponse: false, returnHeaders: false }),
      ),
    },
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            const adapter = ctx.context.internalAdapter;
            // 1.5.4 reads before cleaning expired DB rows. Reject expired
            // challenges even when a client replays an old signed cookie. Keep
            // this request-scoped; plugin initialization rebuilds the adapter.
            ctx.context.internalAdapter = {
              ...adapter,
              async findVerificationValue(identifier) {
                const record = await adapter.findVerificationValue(identifier);
                return record && new Date(record.expiresAt).getTime() > Date.now() ? record : null;
              },
            };
          }),
        },
        {
          matcher: (ctx: { path?: string }) =>
            !!ctx.path &&
            (ctx.path.startsWith("/passkey/") ||
              ctx.path.startsWith("/two-factor/") ||
              ctx.path.startsWith("/account-security/")),
          handler: createAuthMiddleware(async (ctx) => {
            if ((await options.getAuthMode()) !== "local") {
              throw new APIError("FORBIDDEN", {
                code: "ACCOUNT_SECURITY_UNAVAILABLE",
                message:
                  "Manage account security where you sign in. This instance does not host accounts.",
              });
            }
            // Security operations must consult the database, not the SaaS's
            // long-lived session cookie cache. A revoked session cannot enroll
            // another credential or change an existing authenticator.
            // Drop only the incoming cache hint (including chunked cookies).
            // Endpoint middleware can resolve the session again after a miss;
            // keep normal cache writes so enrollment updates the browser's user.
            const cookies = ctx.headers?.get("cookie");
            if (cookies) {
              const cache = ctx.context.authCookies.sessionData.name;
              ctx.headers!.set(
                "cookie",
                cookies
                  .split(";")
                  .map((cookie) => cookie.trim())
                  .filter((cookie) => {
                    const name = cookie.slice(0, cookie.indexOf("=")).trim();
                    return name !== cache && !name.startsWith(`${cache}.`);
                  })
                  .join("; "),
              );
            }
            const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
            if (ctx.path === "/two-factor/enable") {
              if (!session) throw new APIError("UNAUTHORIZED");
              // Re-enabling replaces the secret before it is confirmed. Require
              // a password-verified disable before replacing a working factor.
              if ("twoFactorEnabled" in session.user && session.user.twoFactorEnabled) {
                throw new APIError("CONFLICT", {
                  code: "TWO_FACTOR_ALREADY_ENABLED",
                  message:
                    "Two-factor authentication is already enabled. Disable it before setting up a different authenticator.",
                });
              }
            }
            if (
              ctx.path.startsWith("/passkey/") &&
              typeof ctx.body?.name === "string" &&
              ctx.body.name.length > 80
            ) {
              throw new APIError("BAD_REQUEST", {
                message: "Passkey names must be at most 80 characters.",
              });
            }
          }),
        },
        {
          matcher: (ctx: { path?: string }) =>
            ctx.path === "/passkey/delete-passkey" || ctx.path === "/passkey/update-passkey",
          handler: createAuthMiddleware({ use: [freshSessionMiddleware] }, async () => {}),
        },
      ],
      after: [
        {
          matcher: (ctx: { path?: string }) => isPrimarySignIn(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const location = ctx.context.responseHeaders?.get("location");
            // Better Call wraps middleware results when returnHeaders is true;
            // its middleware type describes only the unwrapped response.
            const result = (await challenge.handler({
              ...ctx,
              returnHeaders: true,
            })) as unknown as {
              headers: Headers;
              response?: { twoFactorRedirect: boolean };
            };
            // Each middleware owns its response headers. Preserve the built-in
            // hook's signed challenge and expired session cookies.
            result.headers.forEach((value, key) => {
              ctx.context.responseHeaders ??= new Headers();
              ctx.context.responseHeaders.append(key, value);
            });
            if (!result.response?.twoFactorRedirect) return;

            ctx.context.newSession = null;
            const cookie = ctx.context.createAuthCookie("two_factor_callback", { maxAge: 600 });
            expireCookie(ctx, cookie);
            if (location && ctx.context.isTrustedOrigin(location, { allowRelativePaths: true })) {
              // OAuth already validated this destination. A signed HttpOnly
              // cookie preserves cloud handoff/MCP consent without accepting a
              // user-editable `next` URL on the challenge page.
              await ctx.setSignedCookie(
                cookie.name,
                location,
                ctx.context.secret,
                cookie.attributes,
              );
              throw ctx.redirect(new URL("/two-factor", options.dashboardUrl).href);
            }
            ctx.context.responseHeaders?.delete("location");
            return ctx.json(result.response);
          }),
        },
        {
          matcher: (ctx: { path?: string }) =>
            ctx.path === "/two-factor/verify-totp" || ctx.path === "/two-factor/verify-backup-code",
          handler: createAuthMiddleware(async (ctx) => {
            // Only a completed sign-in, not enrollment or a failed code check.
            if (!ctx.context.newSession || ctx.context.session) return;
            const cookie = ctx.context.createAuthCookie("two_factor_callback", { maxAge: 600 });
            const redirectURL = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
            expireCookie(ctx, cookie);
            if (
              redirectURL &&
              ctx.context.isTrustedOrigin(redirectURL, { allowRelativePaths: true })
            ) {
              const body = ctx.context.returned;
              if (body && typeof body === "object") return ctx.json({ ...body, redirectURL });
            }
          }),
        },
      ],
    },
  };
  return [passkeys, factors] as const;
}
