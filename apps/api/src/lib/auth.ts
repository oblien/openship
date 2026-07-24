import { betterAuth, type User } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, mcp, emailOTP } from "better-auth/plugins";
import { organization } from "better-auth/plugins/organization";
import { defaultStatements, adminAc, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { createAccessControl } from "better-auth/plugins/access";
import { db, getDriver, repos, schema, and, eq, gt } from "@repo/db";
import { env, runtimeTarget, runtimeTargetId, trustedOrigins } from "../config/env";
import { resolveAuthBaseUrl, resolveDashboardPublicUrl, refreshSelfAppPublicUrl } from "./public-url";
import { sendMail, smtpEnabled, requireEmailVerificationStrict } from "./mail";
import {
  resetPasswordEmail,
  verifyEmailTemplate,
  verifyOtpEmailTemplate,
  organizationInviteEmail,
} from "./email-templates";
import { memberAudit } from "../modules/audit/member-emitter";
import {
  getOrgBillingState,
  teardownBillingForOrg,
} from "../modules/billing/billing-org-cleanup";
import { provisionUser } from "./provision-user";
import { safeErrorMessage } from "@repo/core";

/**
 * Better Auth organization-plugin access control config.
 *
 * We register a fourth role, `restricted`, with no default permissions —
 * its access is granted exclusively via resource_grant rows and enforced
 * by apps/api/src/lib/permission.ts.
 *
 * IMPORTANT: passing a custom `ac` (needed to declare `restricted`) opts
 * OUT of Better Auth's built-in owner/admin/member roles. They are NOT
 * kept automatically — if we don't re-declare them every org role ends up
 * with ZERO permissions (an owner can't even invite a member). So we pass
 * the plugin's own default role ACs (`ownerAc`/`adminAc`/`memberAc`, built
 * from the same `defaultStatements`) back in alongside `restricted`.
 */
const ORG_ACCESS_CONTROLLER = createAccessControl(defaultStatements);
// Restricted role: explicitly no plugin-side permissions on org-management
// endpoints (member CRUD, invitation, team). Our own permission.ts
// resolver gates everything else via resource_grant rows. The `newRole`
// generic infers `K extends never` for an empty statements arg, which
// breaks the `Role<any>` constraint on `roles` — so we declare with
// `ac: []` (zero actions on a real key) to land a usable Role type.
const RESTRICTED_ROLE = ORG_ACCESS_CONTROLLER.newRole({ ac: [] });

/**
 * Per-inviter rate limit on the Better Auth organization plugin's
 * invite-member flow. Counts invitations created by this user across all
 * orgs in the last hour; rejects the create if the user is already at or
 * above the cap. Wired in `beforeCreateInvitation` below.
 */
const INVITE_RATE_LIMIT_PER_HOUR = 50;
const INVITE_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

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
export const isSaasDeployment = runtimeTargetId === "cloud-saas" || env.CLOUD_MODE;

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

export const auth = betterAuth({
  basePath: "/api/auth",
  // Dynamic when served on a public URL — every absolute OAuth/auth URL is built
  // from the forwarded public host so remote MCP clients get reachable endpoints
  // (see resolveAuthBaseUrl). Static runtimeTarget.api otherwise (cloud/dev).
  baseURL: resolveAuthBaseUrl(),

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

    /* Password reset - only functional when SMTP is configured */
    sendResetPassword: smtpEnabled
      ? async ({ user, url }: { user: User; url: string; token: string }) => {
          const email = resetPasswordEmail(user, url);
          await sendMail({ to: user.email, ...email });
        }
      : undefined,

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
          await sendMail({ to: user.email, ...email });
        }
      : undefined,
  },

  /* ---------- OAuth Providers ---------- */
  socialProviders: {
    ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
            scope: ["read:user", "user:email"],
            mapProfileToUser: (profile: any) => ({
              name: profile.name || profile.login,
              email: profile.email || `${profile.id}+${profile.login}@users.noreply.github.com`,
              image: profile.avatar_url,
            }),
          },
        }
      : {}),
    ...(env.GITLAB_CLIENT_ID && env.GITLAB_CLIENT_SECRET
      ? {
          gitlab: {
            clientId: env.GITLAB_CLIENT_ID,
            clientSecret: env.GITLAB_CLIENT_SECRET,
            issuer: env.GITLAB_BASE_URL.replace(/\/$/, ""),
            // api covers browse + clone + webhook management; read_user is default.
            scope: ["api", "read_user"],
            mapProfileToUser: (profile: any) => ({
              name: profile.name || profile.username,
              email:
                profile.email ||
                `${profile.id}+${profile.username}@users.noreply.gitlab.com`,
              image: profile.avatar_url,
            }),
          },
        }
      : {}),
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {}),
  },

  /* ---------- Account Linking ---------- */
  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      allowDifferentEmails: true,
      trustedProviders: ["github", "gitlab", "google"],
    },
  },

  /* ---------- Session ---------- */
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60,            // refresh session every hour
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
        // Only the email-verification flow is used today (sign-in / reset /
        // change-email OTP types are not enabled). Send a link-free code email.
        if (type === "email-verification") {
          const tmpl = verifyOtpEmailTemplate(otp, { expiresMinutes: 10 });
          await sendMail({ to: email, ...tmpl });
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
    organization({
      allowUserToCreateOrganization: true,
      organizationLimit: 10, // per-user cap on org creation
      membershipLimit: 100,  // per-org cap on member count
      creatorRole: "owner",
      invitationExpiresIn: 60 * 60 * 24 * 7, // 7 days
      /**
       * Custom role registration. Better Auth's organization plugin
       * normally only accepts owner/admin/member in update-member-role
       * + invite-member endpoints. We register a fourth role,
       * `restricted`, as a no-default-permissions baseline. Resource-
       * level access is granted via the resource_grant table + checked
       * by apps/api/src/lib/permission.ts — the Better Auth role
       * itself just carries the label.
       */
      ac: ORG_ACCESS_CONTROLLER,
      roles: {
        // Re-declare the built-in roles with their default permissions —
        // custom `ac` above wipes them otherwise (see the block comment).
        // `restricted` carries no plugin permissions; permission.ts gates it
        // via resource_grant rows.
        owner: ownerAc,
        admin: adminAc,
        member: memberAc,
        restricted: RESTRICTED_ROLE,
      },
      sendInvitationEmail: smtpEnabled
        ? async (data) => {
            // Use the instance's PUBLIC url so the accept link works from the
            // invitee's browser (a VPS/self-host box's real domain), not the
            // static loopback default. Falls back to the runtime-target dashboard
            // when no public url is configured (pure localhost dev).
            // Freshen the DB-derived self-app URL so the link uses the domain the
            // operator added in the Domains tab (no restart needed). Env
            // --public-url seed still wins inside resolveDashboardPublicUrl.
            await refreshSelfAppPublicUrl().catch(() => {});
            const inviteBase = resolveDashboardPublicUrl();
            const inviteUrl = `${inviteBase}/accept-invite/${data.id}`;
            const email = organizationInviteEmail({
              invitee: { email: data.email },
              inviter: { name: data.inviter.user.name, email: data.inviter.user.email },
              organizationName: data.organization.name,
              url: inviteUrl,
            });

            // Per-instance source toggle. Default is "platform" — keep
            // invites on our own SMTP identity. Operators on a
            // cloud-only deployment can flip to "cloud" so the relay
            // through /api/cloud/send-invitation on the SaaS owns
            // delivery (sends from the SaaS's own mail infrastructure).
            //
            // The DB read is per-invite — invitations are rare and the
            // round-trip lets operators flip the toggle without
            // bouncing the API.
            const settings = await repos.instanceSettings.get();
            const source = settings?.invitationMailSource === "cloud" ? "cloud" : "platform";

            await sendMail({
              to: data.email,
              preferSource: source,
              // organizationId is required by lib/mail.ts when
              // preferSource === "cloud" on a local instance — the
              // cloudClient uses it to resolve the org owner's cloud
              // session token. Harmless on the platform path.
              organizationId: data.organization.id,
              ...email,
            });
          }
        : undefined,

      /**
       * Lifecycle hooks for the org/member/invitation tables.
       *
       * - `beforeCreateInvitation` enforces a per-inviter rate limit
       *   (50 invitations / hour across all orgs) by throwing an APIError
       *   that the plugin surfaces back to the client as a 429.
       * - The `after*` hooks emit forensic audit rows via the
       *   member-emitter wrapper. We use synchronous `audit.record` for
       *   these since losing a member-mutation row is a security gap.
       *
       * Hooks fire OUTSIDE the Hono request cycle so we can't attach
       * IP/UA — the emitter writes them as null. The `actorUserId` is
       * the user the plugin says triggered the event.
       */
      organizationHooks: {
        beforeCreateInvitation: async ({ invitation, inviter }) => {
          // Any organization — personal OR team — may invite members. The
          // is_team flag now only LABELS the workspace (a user's auto-created
          // personal workspace vs a separately-created team org); it no longer
          // gates invites. A user can share their personal workspace directly,
          // and creating a team org stays an optional, separate path. We still
          // require an orgId so every invitation is org-scoped.
          const orgId = invitation.organizationId;
          if (!orgId) {
            throw new APIError("BAD_REQUEST", {
              message: "organizationId is required to create an invitation",
              code: "INVITE_MISSING_ORG",
            });
          }

          const since = new Date(Date.now() - INVITE_RATE_LIMIT_WINDOW_MS);
          const recent = await repos.invitation.countByInviterSince(inviter.id, since);
          if (recent >= INVITE_RATE_LIMIT_PER_HOUR) {
            throw new APIError("TOO_MANY_REQUESTS", {
              message: `Invitation rate limit reached (${INVITE_RATE_LIMIT_PER_HOUR}/hour). Try again later.`,
            });
          }
          // No data override — return void to keep the plugin's defaults.
          void invitation;
        },

        afterCreateOrganization: async ({ organization, user, member }) => {
          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: user.id },
            {
              eventType: "organization.created",
              resourceType: "organization",
              resourceId: organization.id,
              after: {
                name: organization.name,
                slug: organization.slug,
                creatorMemberId: member.id,
                creatorRole: member.role,
              },
            },
          );
        },

        beforeDeleteOrganization: async ({ organization, user }) => {
          // Pre-flight billing gate. Better Auth commits the org delete
          // immediately after this hook returns — afterDelete only gets
          // to fire forensic cleanup, not block. So the only place we
          // can reject an org-delete with the billing still live is
          // here. Throws propagate out of the plugin as the 4xx the
          // APIError describes (crud-org.mjs awaits this hook without
          // try/catch).
          const billingState = await getOrgBillingState(organization.id);
          if (billingState.blocking) {
            // Audit FIRST so the rejection is observable even if the
            // attacker scripts a flood of delete attempts — every one
            // leaves a row. memberAudit.emit swallows its own errors,
            // so we don't risk the audit-write itself blocking the
            // rejection it's recording.
            await memberAudit.emit(
              { organizationId: organization.id, actorUserId: user.id },
              {
                eventType: "organization.deletion.blocked",
                resourceType: "organization",
                resourceId: organization.id,
                after: {
                  activeSubscriptionCount: billingState.activeSubscriptionCount,
                  openInvoiceCount: billingState.openInvoiceCount,
                  openInvoiceAmountCents: billingState.openInvoiceAmountCents,
                  summary: billingState.summary,
                },
              },
            );
            throw new APIError("CONFLICT", {
              message: `Cannot delete organization while billing is active: ${billingState.summary}. Cancel subscriptions and settle open invoices first.`,
              code: "ORG_DELETE_BILLING_ACTIVE",
            });
          }

          // HIGH F16: snapshot the membership BEFORE Better Auth's
          // CASCADE wipes the member rows. The afterDelete hook needs
          // these for the audit summary and for sanity-checking the
          // session re-point downstream.
          try {
            const members = await repos.member.listByOrganization(organization.id);
            (organization as { _orgDeleteMemberSnapshot?: unknown })._orgDeleteMemberSnapshot =
              members.map((m) => ({
                userId: m.userId,
                role: m.role,
              }));
          } catch (err) {
            console.warn(
              "[organizationHooks.beforeDeleteOrganization] member snapshot failed:",
              safeErrorMessage(err),
            );
          }
        },

        afterDeleteOrganization: async ({ organization, user }) => {
          // HIGH F16: cascade everything Better Auth's built-in CASCADE
          // doesn't reach.
          //
          //   1. teardownBillingForOrg — cancel Stripe subs, suspend
          //      then delete the Oblien namespace. Static import is
          //      safe: no module under modules/billing or modules/audit
          //      imports lib/auth, so there is no cycle to break.
          //   2. resource_grant rows scoped to the org (the FK already
          //      CASCADEs, but the explicit call gives us a count).
          //   3. Session pointers — re-point any session whose
          //      activeOrganizationId is the dead org onto the user's
          //      personal org. The column is NOT NULL by schema.
          //   4. Emit one audit row with the full summary.
          const memberSnapshot =
            (organization as { _orgDeleteMemberSnapshot?: unknown })
              ._orgDeleteMemberSnapshot ?? null;

          let billingResult: {
            subscriptionsCancelled: number;
            subscriptionsFailed: number;
            namespaceDecommissioned: boolean;
            customerDeleted: boolean;
            errors: string[];
          } | null = null;
          try {
            billingResult = await teardownBillingForOrg(organization.id);
          } catch (err) {
            console.error(
              "[organizationHooks.afterDeleteOrganization] billing teardown failed:",
              err,
            );
          }

          let grantsDeleted = 0;
          try {
            grantsDeleted = await repos.resourceGrant.deleteByOrganization(
              organization.id,
            );
          } catch (err) {
            console.error(
              "[organizationHooks.afterDeleteOrganization] grant cleanup failed:",
              err,
            );
          }

          let sessionsRepointed = 0;
          try {
            sessionsRepointed = await repos.session.clearActiveOrganizationId(
              organization.id,
            );
          } catch (err) {
            console.error(
              "[organizationHooks.afterDeleteOrganization] session re-point failed:",
              err,
            );
          }

          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: user.id },
            {
              eventType: "organization.deleted",
              resourceType: "organization",
              resourceId: organization.id,
              before: {
                name: organization.name,
                slug: organization.slug,
                members: memberSnapshot,
              },
              after: {
                subscriptionsCancelled: billingResult?.subscriptionsCancelled ?? 0,
                subscriptionsFailed: billingResult?.subscriptionsFailed ?? 0,
                namespaceDecommissioned:
                  billingResult?.namespaceDecommissioned ?? false,
                customerDeleted: billingResult?.customerDeleted ?? false,
                billingErrors: billingResult?.errors ?? [],
                grantsDeleted,
                sessionsRepointed,
              },
            },
          );
        },

        afterAddMember: async ({ member, user, organization }) => {
          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: user.id },
            {
              eventType: "member.added",
              resourceType: "member",
              resourceId: member.id,
              after: {
                userId: member.userId,
                role: member.role,
              },
            },
          );
        },

        afterRemoveMember: async ({ member, user, organization }) => {
          // Revoke this member's resource_grant rows on the way out so
          // re-adding them later (e.g. as a fresh restricted member)
          // can't silently inherit prior-tenure access. The permission
          // resolver short-circuits on missing membership, so a
          // stale-grant condition is security-inert in practice — but
          // we audit cleanup failures so the condition is observable
          // instead of just console-logged.
          try {
            await repos.resourceGrant.deleteByMember(organization.id, member.userId);
          } catch (err) {
            const message = safeErrorMessage(err);
            console.error(
              "[organizationHooks.afterRemoveMember] grant cleanup failed:",
              err,
            );
            await memberAudit.emit(
              { organizationId: organization.id, actorUserId: user.id },
              {
                eventType: "member.removal.grant_cleanup_failed",
                resourceType: "member",
                resourceId: member.id,
                after: { userId: member.userId, errorMessage: message.slice(0, 500) },
              },
            );
          }

          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: user.id },
            {
              eventType: "member.removed",
              resourceType: "member",
              resourceId: member.id,
              before: {
                userId: member.userId,
                role: member.role,
              },
            },
          );
        },

        afterUpdateMemberRole: async ({ member, previousRole, user, organization }) => {
          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: user.id },
            {
              eventType: "member.role_changed",
              resourceType: "member",
              resourceId: member.id,
              before: { role: previousRole },
              after: { role: member.role, userId: member.userId },
            },
          );
        },

        afterCreateInvitation: async ({ invitation, inviter, organization }) => {
          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: inviter.id },
            {
              eventType: "invitation.created",
              resourceType: "invitation",
              resourceId: invitation.id,
              after: {
                email: invitation.email,
                role: invitation.role,
                status: invitation.status,
              },
            },
          );
        },

        afterAcceptInvitation: async ({ invitation, user, organization, member }) => {
          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: user.id },
            {
              eventType: "invitation.accepted",
              resourceType: "invitation",
              resourceId: invitation.id,
              after: {
                email: invitation.email,
                role: invitation.role,
                memberId: member.id,
              },
            },
          );
        },

        afterRejectInvitation: async ({ invitation, user, organization }) => {
          // Better Auth marks the invitation status=rejected but keeps
          // the row — its CASCADE doesn't fire, so any pending grants
          // we stored for this invite would linger as zombies. Wipe them.
          await repos.invitationPendingGrant
            .deleteByInvitation(invitation.id)
            .catch((err: unknown) =>
              console.error("[afterRejectInvitation] pending-grant cleanup failed:", err),
            );

          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: user.id },
            {
              eventType: "invitation.rejected",
              resourceType: "invitation",
              resourceId: invitation.id,
              before: {
                email: invitation.email,
                role: invitation.role,
              },
            },
          );
        },

        afterCancelInvitation: async ({ invitation, cancelledBy, organization }) => {
          // Same rationale as reject — pending grants on a canceled
          // invitation become zombie rows otherwise.
          await repos.invitationPendingGrant
            .deleteByInvitation(invitation.id)
            .catch((err: unknown) =>
              console.error("[afterCancelInvitation] pending-grant cleanup failed:", err),
            );

          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: cancelledBy.id },
            {
              eventType: "invitation.cancelled",
              resourceType: "invitation",
              resourceId: invitation.id,
              before: {
                email: invitation.email,
                role: invitation.role,
              },
            },
          );
        },
      },
    }),
  ],
});

export type Auth = typeof auth;
