import { organizationOptions, isSaasDeployment } from "./organization-lifecycle";
import { betterAuth, type User } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, mcp, emailOTP } from "better-auth/plugins";
import { organization } from "better-auth/plugins/organization";
import { db, getDriver, repos, schema, and, eq, gt } from "@repo/db";
import { env, runtimeTarget, runtimeTargetId, trustedOrigins } from "../config/env";
import {
  resolveAuthBaseUrl,
  resolveDashboardPublicUrl,
} from "./public-url";
import { sendMail, smtpEnabled, canSendMail, requireEmailVerificationStrict } from "./mail";
import {
  resetPasswordOtpEmail,
  verifyEmailTemplate,
  verifyOtpEmailTemplate,
} from "./email-templates";
import { provisionUser } from "./provision-user";
import { socialProviderCredentials } from "./auth-providers";
import { isAuthorizedLocalSignup } from "./local-bootstrap";

/**
 * Better Auth - handles registration, login, OAuth, sessions, tokens.
 *
 * Browser clients (dashboard) use httpOnly session cookies.
 * API clients (CLI, external) use Bearer tokens via the session token.
 *
 * Routes are mounted at /api/auth/* in app.ts.
 */
// Cookie prefix - distinct per mode so desktop API (port 4000) and
// SaaS API (port 4100) don't collide on localhost (cookies ignore port).
export const COOKIE_PREFIX = env.CLOUD_MODE ? "openship-cloud" : "openship";

// "Is this process the multi-tenant SaaS?" — OPENSHIP_TARGET and CLOUD_MODE are
// independent env vars (runtime-config.ts does no cross-inference), and the SaaS
// runs with both; keying off either avoids missing it if only one is set. Used
// to force email verification before login on SaaS only (self-hosted/desktop
// keep the env-SMTP-gated behavior).
export { isSaasDeployment } from "./organization-lifecycle";

function getSharedCookieDomain() {
  // A localhost / single-label host (dev — including the local SaaS on :4100)
  // can ONLY use host-only cookies: a browser rejects a `Domain=.foo` cookie
  // (e.g. a leftover BETTER_AUTH_COOKIE_DOMAIN=.openship.io) on a `localhost`
  // page, which silently drops the session and makes login loop. Force
  // host-only there, IGNORING any configured domain, so a local SaaS always
  // "treats itself as localhost". Real multi-label hosts fall through.
  try {
    const apiHost = new URL(runtimeTarget.api).hostname;
    if (apiHost.split(".").filter(Boolean).length < 2) return undefined;
  } catch {
    // Unparseable target → fall through to the existing logic.
  }

  if (env.BETTER_AUTH_COOKIE_DOMAIN) {
    return env.BETTER_AUTH_COOKIE_DOMAIN;
  }

  if (!env.CLOUD_MODE) {
    return undefined;
  }

  const urls = [runtimeTarget.api, runtimeTarget.dashboard];

  for (const value of urls) {
    try {
      const hostname = new URL(value).hostname;
      if (hostname === "openship.io" || hostname.endsWith(".openship.io")) {
        return ".openship.io";
      }
    } catch {
      // Ignore invalid URLs and fall back to host-only cookies.
    }
  }

  return undefined;
}

const sharedCookieDomain = getSharedCookieDomain();
const useSessionCookieCache = getDriver() !== "pglite";
const githubOAuth = socialProviderCredentials("github");
const googleOAuth = socialProviderCredentials("google");

export const auth = betterAuth({
  basePath: "/api/auth",
  // Dynamic when served on a public URL — every absolute OAuth/auth URL is built
  // from the forwarded public host so remote MCP clients get reachable endpoints
  // (see resolveAuthBaseUrl). Static runtimeTarget.api otherwise (cloud/dev).
  baseURL: resolveAuthBaseUrl(),

  // Better Auth's production fallback sends browser-flow failures to
  // `/?error=...`. That lands inside the dashboard/session redirects, where the
  // query is lost and an MCP client registration failure looks like a blank
  // login page. Keep OAuth errors on a public, purpose-built dashboard page.
  // Better Auth forwards the URL-encoded `error` and `error_description` params;
  // the dashboard bounds them and renders them as text.
  onAPIError: {
    errorURL: `${resolveDashboardPublicUrl()}/auth/error`,
  },

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      organization: schema.organization,
      member: schema.member,
      invitation: schema.invitation,
      oauthApplication: schema.oauthApplication,
      oauthAccessToken: schema.oauthAccessToken,
      oauthConsent: schema.oauthConsent,
    },
  }),

  /* ---------- Email + Password ---------- */
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,

    /* Password reset is CODE-based, so there is deliberately no
       `sendResetPassword` here.

       Leaving it defined would send a second, link-bearing email alongside the
       code — Better Auth calls this callback from /request-password-reset, which
       is a different endpoint from the OTP one, so both would fire for anyone
       still hitting the old route. The reset code is sent by the emailOTP
       plugin's `sendVerificationOTP` (type: "forget-password"), which refuses
       up front when nothing can deliver — see the guard there. */

    /* Kick every existing session when a password is reset.
       The commonest reason somebody resets a password is that they believe
       someone else has it. Leaving their sessions alive means the reset does
       not actually evict the intruder — it only stops them signing in AGAIN.
       Better Auth has the switch; it was simply never turned on (the retired
       link flow had the same hole). */
    revokeSessionsOnPasswordReset: true,

    /* Email verification.
       - SaaS (CLOUD_MODE): ALWAYS required. No account can sign in until it
         has verified its email — new SaaS signups are created but get no
         session; sign-in on an unverified address is blocked (403) and the
         verification email is (re)sent. Assumes SaaS mail transport works;
         if it can't deliver, signups intentionally cannot complete.
       - Self-hosted / desktop: unchanged — only required when env SMTP is
         configured, so a platform-mailbox instance isn't locked out by a
         transient mail-server fault mid-signup. */
    requireEmailVerification: isSaasDeployment ? true : requireEmailVerificationStrict,
    sendVerificationEmail: smtpEnabled
      ? async ({ user, url }: { user: User; url: string; token: string }) => {
          const email = verifyEmailTemplate(user, url);
          const delivered = await sendMail({ to: user.email, ...email });
          // `requireEmailVerification` blocks sign-in until the address is confirmed,
          // so a silently-dropped verification mail is an account that can never be
          // used. Fail the request instead of creating one.
          if (!delivered) {
            throw new APIError("SERVICE_UNAVAILABLE", {
              message:
                "Could not send the verification email — this instance has no working " +
                "email transport. Configure SMTP in Settings → Email.",
            });
          }
        }
      : undefined,
  },

  /* ---------- OAuth Providers ---------- */
  socialProviders: {
    ...(githubOAuth
      ? {
          github: {
            ...githubOAuth,
            scope: ["read:user", "user:email"],
            mapProfileToUser: (profile: any) => ({
              name: profile.name || profile.login,
              email: profile.email || `${profile.id}+${profile.login}@users.noreply.github.com`,
              image: profile.avatar_url,
            }),
          },
        }
      : {}),
    ...(googleOAuth ? { google: googleOAuth } : {}),
  },

  /* ---------- Account Linking ---------- */
  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      allowDifferentEmails: true,
      trustedProviders: ["github", "google"],
    },
  },

  /* ---------- Session ---------- */
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60, // refresh session every hour
    ...(useSessionCookieCache
      ? {
          cookieCache: {
            enabled: true,
            maxAge: 60 * 60 * 24, // cache session in cookie for 24h (avoids DB hit)
          },
        }
      : {}),
  },

  /* ---------- Custom fields on user ---------- */
  user: {
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "user",
        input: false,
      },
      autoProvisioned: {
        type: "boolean",
        defaultValue: false,
        input: false,
      },
    },
  },

  /* ---------- Database hooks ---------- */
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // Invite-only sign-up on SELF-HOSTED instances (defense-in-depth for the
          // OAuth/social path — password signup is gated earlier by the /sign-up
          // route guard + the token-bound /api/system/invite-signup endpoint).
          // SaaS keeps public signup (skipped). Desktop zero-auth, cloud-mirror,
          // and CLI bootstrap-admin provision via provisionUser (raw) and never
          // reach this hook. On self-host, any account after the FIRST must match
          // a pending, UNEXPIRED invitation issued by a real instance admin.
          if (!isSaasDeployment) {
            // Probe ANY user (not just autoProvisioned=false): a zero-auth box's
            // synthetic user must COUNT, so it doesn't fail open as "no admin".
            const [anyUser] = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
            if (!anyUser && !isAuthorizedLocalSignup()) {
              throw new APIError("FORBIDDEN", {
                message: "Initialize this instance through the local setup before signing in.",
              });
            }
            if (anyUser) {
              const email = (user.email ?? "").trim().toLowerCase();
              const [invite] = await db
                .select({ inviterId: schema.invitation.inviterId })
                .from(schema.invitation)
                .where(
                  and(
                    eq(schema.invitation.email, email),
                    eq(schema.invitation.status, "pending"),
                    gt(schema.invitation.expiresAt, new Date()),
                  ),
                )
                .limit(1);
              const [inviter] = invite
                ? await db
                    .select({ role: schema.user.role })
                    .from(schema.user)
                    .where(eq(schema.user.id, invite.inviterId))
                    .limit(1)
                : [];
              // Instance-admin only: a regular member is role "user" (they own
              // their personal org but can't mint instance accounts).
              const inviterIsAdmin = !!inviter && inviter.role === "admin";
              if (!invite || !inviterIsAdmin) {
                throw new APIError("FORBIDDEN", {
                  message: "Sign-up is invite-only on this instance. Ask an admin to invite you.",
                });
              }
            }
          }
          return { data: user };
        },
        after: async (user) => {
          // Funnel every Better Auth-mediated signup (email/password,
          // OAuth, etc.) through the same provisioning helper used by
          // the cloud-mirror and zero-auth desktop paths. provisionUser
          // is idempotent — the user already exists at this point, so
          // the upsert is a no-op; only the personal org bootstrap runs.
          await provisionUser({
            id: user.id,
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified,
          });
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          // Default activeOrganizationId to the user's deterministic
          // personal org (`org_${userId}`) so the org plugin endpoints
          // work without an explicit setActive call after sign-in.
          //
          // provisionUser guarantees this org + an owner membership
          // exist for every identity before any session can be minted
          // (it runs in user.create.after above, plus in
          // mirrorCloudUser and ensureLocalUser), so this FK target
          // is always valid.
          //
          // Only fires for sessions Better Auth's internal adapter
          // creates (sign-in/sign-up/OAuth/refresh). The direct
          // db.insert(schema.session) inside `mintSession`
          // (lib/cloud-auth-proxy.ts) bypasses Better Auth entirely
          // and sets activeOrganizationId itself.
          if (session.activeOrganizationId) return;
          return {
            data: {
              ...session,
              activeOrganizationId: `org_${session.userId}`,
            },
          };
        },
      },
    },
  },

  /* ---------- Security ---------- */
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins,

  /* ---------- Advanced ---------- */
  advanced: {
    cookiePrefix: COOKIE_PREFIX,
    // Pin secure-cookie behavior when served on a public URL. The dynamic
    // `baseURL` (an object) would otherwise make Better Auth derive `secure`
    // from NODE_ENV (→ true in prod) instead of the previous static-localhost
    // `false` — which renames the session cookie (`__Secure-` prefix, logging
    // everyone out once) and breaks the pre-TLS HTTP window. Preserve today's
    // exact behavior; secure-cookie hardening is a separate, deliberate change.
    ...(env.OPENSHIP_PUBLIC_URL ? { useSecureCookies: false } : {}),
    ...(sharedCookieDomain
      ? {
          crossSubDomainCookies: {
            enabled: true,
            domain: sharedCookieDomain,
          },
        }
      : {}),
  },

  /* ---------- Plugins ---------- */
  plugins: [
    /**
     * Bearer auth — accepts `Authorization: Bearer <session.token>` as
     * an alternative to the session cookie. Needed for server-to-server
     * calls into `auth.api.*` from contexts where we hold the raw
     * session token but not a signed cookie (e.g., the GitHub OAuth
     * bridge in cloud-saas.controller.ts that takes a cloud_session_token
     * and calls linkSocialAccount on behalf of the user).
     *
     * Internally signs the token to a cookie format that Better Auth's
     * session-resolver accepts. Without requireSignature=true (the
     * default), raw unsigned tokens are accepted — which is what we
     * want since the local DB stores the raw session.token.
     */
    bearer(),

    /**
     * Email verification via a short numeric CODE (OTP), not a magic link.
     * `overrideDefaultEmailVerification` reroutes the standard verification
     * flow (triggered by emailAndPassword.requireEmailVerification) to send an
     * OTP instead of a link — codes are far more deliverable (no clickable URL
     * for spam filters to flag). Single send: it REPLACES the link callback, so
     * there's no double email. The gate itself is unchanged — an account still
     * can't sign in until verified; it just verifies by typing a code.
     */
    emailOTP({
      otpLength: 6,
      expiresIn: 60 * 10, // 10 minutes
      // Lock the code after too many wrong tries: Better Auth returns
      // TOO_MANY_ATTEMPTS and invalidates the OTP, so the user must request a
      // fresh one ("locked — check your email for a new code").
      allowedAttempts: 5,
      // Throttle how often a new code can be requested (anti-spam + mail cost).
      // Exceeding it returns a rate-limit error; the UI asks them to wait.
      rateLimit: { window: 60, max: 5 },
      overrideDefaultEmailVerification: true,
      async sendVerificationOTP({ email, otp, type }) {
        // Two flows, both link-free by design. `sign-in` and `change-email` OTP
        // types are not enabled, so they fall through and send nothing.
        if (type === "email-verification") {
          const tmpl = verifyOtpEmailTemplate(otp, { expiresMinutes: 10 });
          const delivered = await sendMail({ to: email, ...tmpl });

          // DEV ESCAPE HATCH, `local-saas` ONLY.
          //
          // That target is a localhost-only SaaS used for development
          // (`OPENSHIP_TARGET=local-saas`, ports 4100/3100) and it normally has no
          // mail transport at all. Because CLOUD_MODE is true there,
          // `requireEmailVerification` is forced on — so without this, signup on a
          // dev machine is a dead end: the account is created, no session is issued,
          // and the code needed to finish is inside an email nothing can send.
          //
          // Printing an auth credential to a log is only acceptable because of how
          // narrow the gate is: `runtimeTargetId` comes from OPENSHIP_TARGET, an
          // explicit operator choice validated against a fixed table (an unknown
          // value throws at boot), and the `cloud-saas` row — production — cannot
          // reach this branch. It is NOT gated on NODE_ENV, which flips by accident.
          if (runtimeTargetId === "local-saas") {
            console.warn(
              `\n[dev:local-saas] email verification code for ${email}: ${otp}\n` +
                `  (expires in 10 min. Logged because this target has no mail transport; ` +
                `never happens on cloud-saas.)\n`,
            );
            // Deliberately does NOT throw on a delivery failure here, unlike every
            // other target. The code above is the delivery channel on this target, so
            // failing the request would make the account uncreatable.
            return;
          }

          if (!delivered) {
            throw new APIError("SERVICE_UNAVAILABLE", {
              message:
                "Could not send the verification code — this instance has no working " +
                "email transport. Configure SMTP in Settings → Email.",
            });
          }
          return;
        }
        // Password reset. This replaced the link flow (`sendResetPassword` in the
        // emailAndPassword block is deliberately gone): a "click here to change your
        // password" URL is the most phishing-shaped mail we send, gets scored and
        // rewritten by gateways, and a rewritten link is indistinguishable from an
        // attack to whoever reads it. Same reasoning that already made verification
        // a code.
        if (type === "forget-password") {
          // Refuse loudly when nothing can deliver. `sendMail` returns SILENTLY with
          // no transport configured (it warns to the server log and moves on), which
          // on this flow means the operator is told to check their inbox for a code
          // that was never sent, and waits — with the account still locked out. That
          // is worse than an error. `smtpEnabled` cannot express this: it is a
          // constant `true` ("callbacks wired; runtime decides delivery"), so
          // `canSendMail()` is the only honest check.
          if (!(await canSendMail())) {
            throw new APIError("SERVICE_UNAVAILABLE", {
              message:
                "This instance has no email transport configured, so a reset code " +
                "cannot be sent. Configure SMTP in Settings → Email, or reset the " +
                "password from the server with `openship reset-admin`.",
            });
          }
          const tmpl = resetPasswordOtpEmail(otp, { expiresMinutes: 10 });
          // Check the RESULT as well as the pre-flight above. `canSendMail()` reads a
          // transport cache with a 60s TTL, so it can say yes for a config that has
          // since been changed or broken — and being told to check your inbox while
          // locked out is the worst place to be optimistic.
          if (!(await sendMail({ to: email, ...tmpl }))) {
            throw new APIError("SERVICE_UNAVAILABLE", {
              message:
                "Could not send the reset code — this instance has no working email " +
                "transport. Configure SMTP in Settings → Email, or reset the password " +
                "from the server with `openship reset-admin`.",
            });
          }
        }
      },
    }),

    /**
     * MCP OAuth 2.1 authorization server. Turns Openship into a standards-
     * compliant remote MCP server: discovery-based clients (Claude, Cursor)
     * self-register (DCR), run the PKCE authorize flow, hit our consent page,
     * and receive an OAuth access token. That token is then bridged into the
     * SAME scoped-principal permission model a scoped PAT uses (see
     * `tryOAuthMcpAuth` in middleware/auth.ts) — no duplicated authorization.
     *
     * Endpoints mounted under /api/auth: /.well-known/oauth-authorization-server,
     * /.well-known/oauth-protected-resource, /mcp/{authorize,token,register,
     * get-session}, /oauth2/consent. Discovery is re-served at the origin root
     * in app.ts (the spec expects it there, not under /api/auth).
     *
     * PATs remain the API-key path for REST/CLI and still authenticate /api/mcp.
     */
    mcp({
      // Redirect targets on the DASHBOARD — the public dashboard origin when
      // served publicly (a remote OAuth client must land on a reachable login/
      // consent page, not localhost:3001), else the static runtime dashboard.
      loginPage: `${resolveDashboardPublicUrl()}/login`,
      oidcConfig: {
        loginPage: `${resolveDashboardPublicUrl()}/login`,
        consentPage: `${resolveDashboardPublicUrl()}/mcp/authorize`,
        requirePKCE: true, // OAuth 2.1
        storeClientSecret: "hashed",
        allowDynamicClientRegistration: true, // MCP clients self-register
      },
    }),

    /**
     * Multi-user / multi-team via Better Auth's first-party organization
     * plugin. Adds the org/member/invitation tables + endpoints under
     * /api/auth/organization/* (create, invite-member, accept-invitation,
     * set-active, list, update-member-role, remove-member, leave).
     *
     * One user CAN belong to multiple orgs (membersLimit applies per-org).
     * Resources are scoped to organization_id by middleware in
     * apps/api/src/middleware/active-organization.ts.
     */
    organization(organizationOptions),
  ],
});

export type Auth = typeof auth;
