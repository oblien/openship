/**
 * Setup controller - Electron → API direct push of instance config.
 *
 * Called once after onboarding with the internal token.
 * Persists SSH credentials, tunnel config, and default build mode
 * as instance-level settings (not per-user).
 *
 * Security: These handlers are loaded via dynamic import only in
 * self-hosted mode. Additionally, each handler checks CLOUD_MODE as
 * defense-in-depth - if somehow mounted in cloud, they refuse to run.
 */

import type { Context } from "hono";
import { setSignedCookie } from "hono/cookie";
import { db, repos, schema, eq, and } from "@repo/db";
import { generateId, normalizeRollbackWindow, safeErrorMessage } from "@repo/core";
import { hashPassword } from "better-auth/crypto";
import { invalidateOpenRestyPaths } from "@/lib/openresty-paths";
import { env } from "../../config";
import { audit, auditContextFrom } from "../../lib/audit";
import { getRequestContext } from "../../lib/request-context";
import {
  AUTH_MODES,
  clearAuthModeCache,
  pinnedAuthMode,
  type AuthMode as AuthModeType,
} from "../../lib/auth-mode";
import { assertNotCloud } from "../../lib/controller-helpers";
import {
  PRODUCT_MODES,
  clearProductModeCache,
  isProductMode,
  resolveProductMode,
} from "../../lib/product-mode";
import {
  clearHostControlCache,
  resolveHostControlEnabled,
  syncHostControlOverride,
} from "../../lib/host-control";
import { boxOwningOrgId } from "../../lib/box-org";
import { encrypt } from "../../lib/encryption";
import {
  sendInstanceTestEmail,
  invalidateInstanceTransportCache,
  canSendMail,
} from "../../lib/mail";
import { assertInstanceAdmin } from "../../middleware/instance-admin";
import { zeroAuthAllowed } from "../../middleware/zero-auth-guard";
import { getInstanceReachability } from "../../lib/public-url";
import { sshManager } from "../../lib/ssh-manager";
import { encryptSecretField } from "@/lib/credential-encryption";
import { ensureLocalUser, invalidateLocalUserCache } from "../../lib/local-user";
import { ensureLocalServer } from "../../lib/startup/self-server";
import { provisionUser } from "../../lib/provision-user";
import { COOKIE_PREFIX } from "../../lib/auth";
import { mintSession } from "../../lib/cloud-auth-proxy";
import { invalidatePlatformTransport } from "../../lib/mail";
import * as dnsCredentialService from "../dns/dns-credential.service";
import { cloudflareDnsProvider } from "../dns/providers/cloudflare.provider";

/** The canonical mode set lives with the resolver, so the env parser, this
 *  validator and getAuthMode() can't disagree about what a valid mode is. */
const VALID_AUTH_MODES = AUTH_MODES;
type AuthMode = AuthModeType;

/**
 * Result of validating an incoming authMode change. `error` is set when
 * the change must be refused — callers should return the embedded JSON +
 * status as-is. `value` is the canonical mode to persist on success.
 */
type AuthModeValidation =
  | { ok: true; value: AuthMode }
  | { ok: false; status: 400 | 403 | 409; body: { error: string } };

/**
 * Validate an authMode write against the canonical mode set + the
 * two-key safety gate for flipping a non-desktop deployment to zero-auth.
 *
 * Zero-auth on a network-reachable instance means anyone who can hit the
 * API can act as admin, so the operator must opt in via the
 * OPENSHIP_ALLOW_ZERO_AUTH env var (deliberate restart) AND echo the
 * confirmation phrase in the request body (deliberate click) before we
 * write the value. Desktop deployments bypass the gate — loopback-only
 * Electron is the default zero-auth target.
 */
function validateAuthModeChange(body: Record<string, unknown>): AuthModeValidation {
  const raw = body.authMode;
  if (typeof raw !== "string" || !VALID_AUTH_MODES.includes(raw as AuthMode)) {
    return {
      ok: false,
      status: 400,
      body: { error: `authMode must be one of: ${VALID_AUTH_MODES.join(", ")}` },
    };
  }
  const value = raw as AuthMode;

  // A declared mode (OPENSHIP_AUTH_MODE) outranks the DB, so a write that
  // disagrees with it would persist a value the API will never honour — silent,
  // confusing, and exactly how the desktop ended up with a stored "cloud" it
  // couldn't act on. Refuse instead of writing a lie. Writing the SAME value is
  // allowed so idempotent callers don't break.
  const pinned = pinnedAuthMode();
  if (pinned && value !== pinned) {
    return {
      ok: false,
      status: 409,
      body: {
        error:
          `authMode is pinned to "${pinned}" by OPENSHIP_AUTH_MODE and cannot be changed ` +
          `at runtime. Change that environment variable and restart the API.`,
      },
    };
  }

  if (value === "none" && env.DEPLOY_MODE !== "desktop") {
    if (!env.OPENSHIP_ALLOW_ZERO_AUTH) {
      return {
        ok: false,
        status: 403,
        body: {
          error:
            "Zero-auth toggle disabled. Operator must set OPENSHIP_ALLOW_ZERO_AUTH=true and restart.",
        },
      };
    }
    if (body.confirm !== "I-understand-no-auth") {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'Zero-auth toggle requires `confirm: "I-understand-no-auth"` in the request body.',
        },
      };
    }
  }

  return { ok: true, value };
}

/** POST /system/setup - push all instance settings from desktop app.
 *
 *  PRE-AUTH: runs under internalAuth (shared token), no RequestContext.
 *  Reads activeOrganizationId off the raw Hono context when middleware
 *  happens to have set it; otherwise treats the row as instance-global. */
export async function setup(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;

  const body = await c.req.json();

  // Instance-level config (non-SSH) → instance_settings table.
  // authMode is security-sensitive and this handler is ALSO reachable
  // UNauthenticated via POST /onboarding — so run the SAME zero-auth safety
  // gate the authenticated PATCH /settings uses, and never blindly force
  // "none" when the caller omits it (that default is exactly what let a public
  // first-run request weaken the instance). When omitted, leave authMode unset
  // so the canonical getAuthMode() default applies (self-hosted → "local").
  const settingsPatch: Record<string, unknown> = {
    tunnelProvider: body.tunnelProvider || null,
    tunnelToken: body.tunnelToken || null,
    defaultBuildMode: body.defaultBuildMode || "auto",
    defaultRollbackWindow: normalizeRollbackWindow(body.defaultRollbackWindow),
  };
  if (body.authMode !== undefined) {
    const validation = validateAuthModeChange(body);
    if (!validation.ok) return c.json(validation.body, validation.status);
    settingsPatch.authMode = validation.value;
  }
  await repos.instanceSettings.upsert(settingsPatch);
  clearAuthModeCache();

  // SSH server config → servers table (single source of truth)
  let serverId: string | undefined;
  if (body.sshHost) {
    // Resolve which server this setup call targets:
    //   - explicit serverId         → that exact server (reconfigure by id)
    //   - else same-host match       → idempotent re-run of setup for the
    //                                   SAME machine (update it in place)
    //   - else                       → a DIFFERENT machine → create a new row
    //
    // The previous `(await repos.server.list())[0]` blindly grabbed the FIRST
    // server and overwrote it — so adding a second server CLOBBERED the first
    // (the "at most one server" onboarding assumption no longer holds). Match
    // by host so a new machine never destroys an existing one.
    const existing = body.serverId
      ? await repos.server.get(body.serverId)
      : ((await repos.server.list()).find((s) => s.sshHost === body.sshHost) ?? null);

    // Encrypt SSH secrets at rest. Decrypted only inside `buildSshConfig`
    // when the ssh2 client needs them. See lib/credential-encryption.
    const encryptedPassword = encryptSecretField(body.sshPassword);
    const encryptedKeyPassphrase = encryptSecretField(body.sshKeyPassphrase);

    if (existing) {
      await repos.server.update(existing.id, {
        name: body.serverName || null,
        sshHost: body.sshHost,
        sshPort: body.sshPort || 22,
        sshUser: body.sshUser || "root",
        sshAuthMethod: body.sshAuthMethod || null,
        sshPassword: encryptedPassword,
        sshKeyPath: body.sshKeyPath || null,
        sshKeyPassphrase: encryptedKeyPassphrase,
        sshJumpHost: body.sshJumpHost || null,
        sshArgs: body.sshArgs || null,
      });
      serverId = existing.id;
    } else {
      // Setup runs through internalAuth / onboarding (no user session), so
      // there's no active org in context. Use whatever the middleware may
      // have set, otherwise leave NULL — these are instance-global servers
      // per the schema comment. Operators assign org post-onboarding.
      const ctxOrgId = c.get("activeOrganizationId");
      const organizationId = typeof ctxOrgId === "string" && ctxOrgId.length > 0 ? ctxOrgId : null;
      const created = await repos.server.create({
        organizationId,
        name: body.serverName || null,
        sshHost: body.sshHost,
        sshPort: body.sshPort || 22,
        sshUser: body.sshUser || "root",
        sshAuthMethod: body.sshAuthMethod || null,
        sshPassword: encryptedPassword,
        sshKeyPath: body.sshKeyPath || null,
        sshKeyPassphrase: encryptedKeyPassphrase,
        sshJumpHost: body.sshJumpHost || null,
        sshArgs: body.sshArgs || null,
      });
      serverId = created.id;
    }
    sshManager.invalidate(serverId);
    await invalidateOpenRestyPaths(serverId);
  }

  clearAuthModeCache();
  return c.json({ ok: true });
}

/** GET /system/setup - retrieve current instance settings */
export async function getSetup(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;

  const settings = await repos.instanceSettings.get();
  const servers = await repos.server.list();
  const hasServer = servers.length > 0;
  // Source-of-truth for "can teammates reach this instance + at what URL" —
  // drives the smart team-invite gate + its inline guidance (see TeamTab).
  const teamReachability = await getInstanceReachability().catch(() => null);

  return c.json({
    configured: hasServer,
    authMode: settings?.authMode ?? "none",
    tunnelProvider: settings?.tunnelProvider ?? null,
    defaultBuildMode: settings?.defaultBuildMode ?? "auto",
    defaultRollbackWindow: normalizeRollbackWindow(settings?.defaultRollbackWindow),
    invitationMailSource: settings?.invitationMailSource ?? "platform",
    teamMode: settings?.teamMode ?? "single_user",
    migrationTargetUrl: settings?.migrationTargetUrl ?? null,
    migratedAt: settings?.migratedAt?.toISOString() ?? null,
    // Instance-wide auto-update of remote edge/mail containers when this control
    // plane's APP_VERSION moves forward. Server-side (works on desktop too),
    // distinct from the desktop-only Electron app auto-update.
    autoUpdateInfra: settings?.autoUpdateInfra ?? false,
    autoScanInfra: settings?.autoScanInfra ?? true,
    // Two values, because the settings toggle has to distinguish "the operator
    // chose this" from "this is what the env happens to default to": productMode
    // is the raw stored override (null = unset) and productModeEffective is what
    // the dashboard actually renders. Collapsing them would make an unset row
    // look like an explicit choice and silently overwrite the env default on the
    // next unrelated save.
    productMode: settings?.productMode ?? null,
    productModeEffective: await resolveProductMode(),
    // Same raw+effective split as productMode, for the same reason (#527's runtime
    // toggle): hostControl is the stored override (null = unset, env decides) and
    // hostControlEffective is whether the box is actually a deploy target right now.
    // The toggle needs both so an unset row isn't mistaken for an explicit choice.
    hostControl: settings?.hostControlEnabled ?? null,
    hostControlEffective: await resolveHostControlEnabled(),
    teamReachability,
  });
}

/** PATCH /system/settings - partial update instance-level settings (non-SSH) */
export async function updateSettings(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;

  // Defense in depth behind requireInstanceAdmin() on the route, so a future
  // mount can't re-open GHSA-43hf-p5j8-8vhx by forgetting the middleware.
  await assertInstanceAdmin(getRequestContext(c));

  const body = (await c.req.json()) as Record<string, unknown>;

  // Only instance-level fields - SSH changes go through the servers API.
  const patch: Record<string, unknown> = {};

  // authMode changes are security-sensitive: validate against the canonical
  // set, enforce the zero-auth safety gate, and capture the previous value
  // for the audit row written after the upsert succeeds.
  let authModeChange: { before: AuthMode | null; after: AuthMode } | null = null;
  if (body.authMode !== undefined) {
    const validation = validateAuthModeChange(body);
    if (!validation.ok) {
      return c.json(validation.body, validation.status);
    }
    const prev = (await repos.instanceSettings.get())?.authMode ?? null;
    patch.authMode = validation.value;
    authModeChange = {
      before: (prev as AuthMode | null) ?? null,
      after: validation.value,
    };
  }
  if (body.tunnelProvider !== undefined) patch.tunnelProvider = body.tunnelProvider || null;
  if (body.tunnelToken !== undefined) patch.tunnelToken = body.tunnelToken || null;
  if (body.defaultBuildMode !== undefined) patch.defaultBuildMode = body.defaultBuildMode || "auto";
  if (body.defaultRollbackWindow !== undefined) {
    patch.defaultRollbackWindow = normalizeRollbackWindow(body.defaultRollbackWindow);
  }
  if (body.invitationMailSource !== undefined) {
    const raw = body.invitationMailSource;
    if (raw !== "platform" && raw !== "cloud") {
      return c.json({ error: "invitationMailSource must be 'platform' or 'cloud'" }, 400);
    }
    patch.invitationMailSource = raw;
  }
  if (body.autoUpdateInfra !== undefined) patch.autoUpdateInfra = Boolean(body.autoUpdateInfra);
  if (body.autoScanInfra !== undefined) patch.autoScanInfra = Boolean(body.autoScanInfra);
  // Openship Mail. `null` clears the override so OPENSHIP_PRODUCT governs again —
  // that's a meaningful state, not an absent field, so it's accepted explicitly.
  if (body.productMode !== undefined) {
    if (body.productMode !== null && !isProductMode(body.productMode)) {
      return c.json(
        { error: `productMode must be one of: ${PRODUCT_MODES.join(", ")}, or null` },
        400,
      );
    }
    patch.productMode = body.productMode;
  }
  // Host control (#527): may OpenShip deploy to the machine it runs on? `null`
  // clears the override so OPENSHIP_HOST_CONTROL governs again — a meaningful
  // state, accepted explicitly like productMode.
  //
  // Unlike every other field here this grants PRIVILEGED behavior (host-root
  // deploys via the container→host channel + mounted docker socket), so it is
  // gated harder than requireInstanceAdmin: only the box-owning org may flip it,
  // the exact gate createServer's loopback-adoption uses. A teammate admin in
  // another org must not be able to self-grant a host-root deploy target.
  if (body.hostControl !== undefined) {
    if (body.hostControl !== null && typeof body.hostControl !== "boolean") {
      return c.json({ error: "hostControl must be true, false, or null" }, 400);
    }
    if (getRequestContext(c).organizationId !== (await boxOwningOrgId())) {
      return c.json(
        { error: "Only the owner of this machine's workspace can change host control." },
        403,
      );
    }
    patch.hostControlEnabled = body.hostControl;
  }

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  await repos.instanceSettings.upsert(patch);

  clearAuthModeCache();
  clearProductModeCache();

  // Host-control write: push the new value into the adapters gate and reconcile
  // the isLocal row so the change takes effect without a restart.
  if (body.hostControl !== undefined) {
    clearHostControlCache();
    await syncHostControlOverride().catch(() => {});
    if (await resolveHostControlEnabled()) {
      // Enabled: materialize "This Server" now so it's a target immediately (the
      // GET /servers self-heal would do it eventually, but the toggle should be
      // instant). On Compose the row appears and container deploys work at once;
      // host-OS ops still refuse with the "re-run `openship up`" advisory until the
      // CLI provisions the channel — the deliberate degrade-and-advise behaviour.
      await ensureLocalServer().catch(() => null);
    } else {
      // Disabled: drop the pooled host channel (and every other cached executor)
      // so an already-connected channel can't keep serving host ops past the flip —
      // the acquire fast-path returns before the gate runs, so a live cache would
      // silently defer the disable until idle eviction.
      sshManager.invalidate();
    }
  }

  if (authModeChange) {
    const ctx = getRequestContext(c);
    audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
      eventType: "auth-mode-changed",
      resourceType: "instance-settings",
      resourceId: "instance",
      before: { authMode: authModeChange.before },
      after: { authMode: authModeChange.after },
    });
  }

  return c.json({ ok: true });
}

// ─── Instance SMTP (Settings → Email) ────────────────────────────────────────

const SMTP_HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * GET /system/settings/email — the instance SMTP config, MASKED. The password
 * is never returned; `hasPassword` tells the UI whether one is stored so it can
 * offer "leave blank to keep".
 */
export async function getEmailSettings(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;
  const s = await repos.instanceSettings.get();
  const configured = !!(s?.smtpHost && s?.smtpUser && s?.smtpPasswordEncrypted);
  return c.json({
    configured,
    host: s?.smtpHost ?? null,
    port: s?.smtpPort ?? null,
    user: s?.smtpUser ?? null,
    from: s?.smtpFrom ?? null,
    hasPassword: !!s?.smtpPasswordEncrypted,
    // Whether ANY transport can currently deliver (instance SMTP, mail-server
    // mailbox, or env). Drives the "no email transport → set up SMTP" hints —
    // e.g. the notification channel form.
    deliverable: await canSendMail().catch(() => false),
  });
}

/**
 * PUT /system/settings/email — set (or clear) the instance SMTP config. The
 * password is encrypted at rest; an omitted/blank password KEEPS the stored one
 * (the client never receives it to echo back). An empty host clears the whole
 * config (disables instance SMTP). Invalidates the mail transport cache so the
 * next send picks up the change.
 */
export async function updateEmailSettings(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const host = typeof body.host === "string" ? body.host.trim().toLowerCase() : "";

  // Empty host = clear/disable instance SMTP.
  if (!host) {
    await repos.instanceSettings.upsert({
      smtpHost: null,
      smtpPort: null,
      smtpUser: null,
      smtpPasswordEncrypted: null,
      smtpFrom: null,
    });
    invalidateInstanceTransportCache();
    return c.json({ ok: true, configured: false });
  }

  if (!SMTP_HOST_RE.test(host)) return c.json({ error: "Invalid SMTP host" }, 400);

  const user = typeof body.user === "string" ? body.user.trim() : "";
  if (!user) return c.json({ error: "SMTP username is required" }, 400);

  const portRaw =
    body.port === undefined || body.port === null || body.port === "" ? 587 : Number(body.port);
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    return c.json({ error: "Invalid SMTP port" }, 400);
  }

  const from = typeof body.from === "string" && body.from.trim() ? body.from.trim() : null;

  // Password: a non-empty value replaces; blank/omitted keeps the existing one
  // (the client never has the plaintext to resend). Require one on first set.
  const existing = await repos.instanceSettings.get();
  const passwordInput = typeof body.password === "string" ? body.password : "";
  let smtpPasswordEncrypted: string | null;
  if (passwordInput) {
    smtpPasswordEncrypted = encrypt(passwordInput);
  } else if (existing?.smtpPasswordEncrypted) {
    smtpPasswordEncrypted = existing.smtpPasswordEncrypted;
  } else {
    return c.json({ error: "SMTP password is required" }, 400);
  }

  await repos.instanceSettings.upsert({
    smtpHost: host,
    smtpPort: portRaw,
    smtpUser: user,
    smtpPasswordEncrypted,
    smtpFrom: from,
  });
  invalidateInstanceTransportCache();
  return c.json({ ok: true, configured: true });
}

/**
 * POST /system/settings/email/test — send a test message through the saved
 * instance SMTP. Surfaces the real transport error (wrong host/port/creds) so
 * the operator can fix it before relying on it for password resets.
 */
export async function sendTestEmail(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (!to || !EMAIL_RE.test(to)) {
    return c.json({ error: "A valid recipient email is required" }, 400);
  }

  try {
    await sendInstanceTestEmail(to);
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send test email";
    return c.json({ ok: false, error: message }, 400);
  }
}

/** DELETE /system/settings - remove server configuration */
export async function deleteSettings(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;
  const ctx = getRequestContext(c);

  await repos.instanceSettings.delete();

  // Clear the CALLER'S-ORG servers only (SSH config lives in the servers table).
  // MUST be org-scoped: `repos.server.list()` returns every org's servers, so a
  // global delete here let an org owner wipe OTHER organizations' servers
  // (broken access control). Scope to ctx.organizationId — same scope as the
  // Servers list / `server:admin` delete. Purge per-server grants alongside each
  // so no orphan resource_grant rows point at deleted resources.
  const serverList = await repos.server.listByOrganization(ctx.organizationId);
  for (const s of serverList) {
    if (s.organizationId) {
      await repos.resourceGrant
        .deleteForResource(s.organizationId, "server", s.id)
        .catch((err: unknown) =>
          console.error("[deleteSettings] server grant cleanup failed:", err),
        );
      await repos.resourceGrant
        .deleteForResource(s.organizationId, "mail_server", s.id)
        .catch((err: unknown) =>
          console.error("[deleteSettings] mail_server grant cleanup failed:", err),
        );
    }
    await repos.server.delete(s.id);
  }

  sshManager.invalidate();
  await invalidateOpenRestyPaths();
  clearAuthModeCache();
  // The row just dropped held host_control_enabled (#527). Without reconciling here
  // the cached effective value and the pushed adapters override would both survive
  // the delete and keep serving the deleted choice until the next boot — so re-sync
  // to let the OPENSHIP_HOST_CONTROL env floor govern again.
  clearHostControlCache();
  await syncHostControlOverride().catch(() => {});
  return c.json({ ok: true });
}

// ── Onboarding (first-run, no auth required) ─────────────────────────────────

/**
 * GET /system/onboarding - check whether onboarding is complete.
 * No auth required - used by CLI polling and first-run detection.
 */
export async function onboardingStatus(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;

  const servers = await repos.server.list();
  return c.json({ configured: servers.length > 0 });
}

// ── First-admin bootstrap (CLI setup) ────────────────────────────────────────

/**
 * POST /system/bootstrap-admin — create the FIRST admin from the CLI.
 *
 * How `openship` setup makes a CLI-managed instance without ever using
 * zero-auth: the service boots in local-auth mode (OPENSHIP_REQUIRE_AUTH), and
 * the CLI — holding the instance's INTERNAL_TOKEN — calls this to mint the
 * initial email/password admin. It reuses the exact account-creation the
 * desktop onboarding uses (ensureLocalUser → credential account → authMode
 * local), so the admin owns the auto-created personal org.
 *
 * Gates (defense in depth):
 *   - `internalAuth` at the route: requires X-Internal-Token, so a browser
 *     reaching this through the public dashboard proxy can't call it.
 *   - one-shot: refuses once any real (non-auto-provisioned) admin exists.
 */
export async function bootstrapAdmin(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;

  const existing = await repos.user.findFoundingAdmin();
  if (existing) {
    return c.json({ error: "An admin account already exists" }, 409);
  }

  const body = (await c.req.json()) as { name?: unknown; email?: unknown; password?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!name || name.length < 1 || name.length > 100) {
    return c.json({ error: "name is required (1-100 chars)" }, 400);
  }
  if (!email || !email.includes("@") || email.length > 254) {
    return c.json({ error: "email must be a valid address" }, 400);
  }
  if (password.length < 8 || password.length > 128) {
    return c.json({ error: "password must be 8-128 characters" }, 400);
  }

  // This route's whole point is flipping the instance to "local" as it creates the
  // first admin. If the mode is pinned to something else, that flip can't happen —
  // so refuse up front rather than create an admin the API will never ask for.
  const pinned = pinnedAuthMode();
  if (pinned && pinned !== "local") {
    return c.json(
      {
        error:
          `authMode is pinned to "${pinned}" by OPENSHIP_AUTH_MODE, so creating a ` +
          `password admin would have no effect. Set OPENSHIP_AUTH_MODE=local and restart first.`,
      },
      409,
    );
  }

  const localUser = await ensureLocalUser();
  const conflict = await repos.user.findByEmail(email);
  if (conflict && conflict.id !== localUser.id) {
    return c.json({ error: "An account with this email already exists" }, 409);
  }

  const hashed = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx
      .update(schema.user)
      .set({ name, email, emailVerified: true, autoProvisioned: false, updatedAt: new Date() })
      .where(eq(schema.user.id, localUser.id));
    await tx
      .delete(schema.account)
      .where(
        and(eq(schema.account.userId, localUser.id), eq(schema.account.providerId, "credential")),
      );
    await tx.insert(schema.account).values({
      id: generateId("acc"),
      accountId: localUser.id,
      providerId: "credential",
      userId: localUser.id,
      password: hashed,
    });
    await tx
      .insert(schema.instanceSettings)
      .values({ id: "default", authMode: "local" })
      .onConflictDoUpdate({
        target: schema.instanceSettings.id,
        set: { authMode: "local", updatedAt: new Date() },
      });
  });

  invalidateLocalUserCache();
  clearAuthModeCache();

  // Register "This Server" NOW that a founding admin exists. The boot hook already
  // ran and bailed for want of one (the API comes up before the CLI calls this), and
  // nothing else re-runs it — so without this a freshly installed box showed
  // "No servers yet" until the API happened to restart, even though Openship itself
  // was listed under Apps. Best-effort: a failure here must not fail the bootstrap,
  // since the boot hook will still catch it on the next restart.
  await ensureLocalServer().catch((err) =>
    console.warn("[setup] local server registration deferred to next boot:", safeErrorMessage(err)),
  );

  audit.recordAsync(auditContextFrom(c, `org_${localUser.id}`, localUser.id), {
    eventType: "admin.bootstrapped",
    resourceType: "instance-settings",
    resourceId: "instance",
    after: { userId: localUser.id, email },
  });

  return c.json({ ok: true, email });
}

/**
 * POST /api/system/reset-admin-password — internal-token-gated password reset.
 *
 * The CLI holds the loopback internal token ("god access"), so a locked-out
 * operator can reset their own login WITHOUT signing in — the recovery path for
 * a forgotten password. Unlike bootstrap-admin this REQUIRES an existing admin,
 * resets that account's credential password, and forces authMode back to "local"
 * (so it also recovers a box that got stuck on a broken cloud login). Optional
 * `email`/`name` let you correct the admin's address at the same time.
 */
export async function resetAdminPassword(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;

  const body = (await c.req.json()) as { email?: unknown; name?: unknown; password?: unknown };
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 8 || password.length > 128) {
    return c.json({ error: "password must be 8-128 characters" }, 400);
  }
  if (typeof body.name === "string" && body.name.trim().length > 100) {
    return c.json({ error: "name must be 1-100 characters" }, 400);
  }

  // Deterministic target: the founding owner (earliest real account), so on a
  // multi-user box the reset never lands on an arbitrary member row.
  const admin = await repos.user.findFoundingAdmin();
  if (!admin) {
    return c.json({ error: "No admin account exists yet — run `openship` to create one." }, 409);
  }

  const email =
    typeof body.email === "string" && body.email.trim()
      ? body.email.trim().toLowerCase()
      : admin.email;
  if (!email || !email.includes("@") || email.length > 254) {
    return c.json({ error: "email must be a valid address" }, 400);
  }
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : admin.name;
  const conflict = await repos.user.findByEmail(email);
  if (conflict && conflict.id !== admin.id) {
    return c.json({ error: "Another account already uses this email" }, 409);
  }

  const hashed = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx
      .update(schema.user)
      .set({ email, name, emailVerified: true, updatedAt: new Date() })
      .where(eq(schema.user.id, admin.id));
    await tx
      .delete(schema.account)
      .where(and(eq(schema.account.userId, admin.id), eq(schema.account.providerId, "credential")));
    await tx.insert(schema.account).values({
      id: generateId("acc"),
      accountId: admin.id,
      providerId: "credential",
      userId: admin.id,
      password: hashed,
    });
    await tx
      .insert(schema.instanceSettings)
      .values({ id: "default", authMode: "local" })
      .onConflictDoUpdate({
        target: schema.instanceSettings.id,
        set: { authMode: "local", updatedAt: new Date() },
      });
  });

  // Password recovery must mean "regain sole control": revoke every existing
  // session for the account so a stolen/leftover session can't survive the reset
  // (session tokens are opaque row refs — rotating the credential alone doesn't
  // invalidate them).
  await repos.session.revokeAllForUser(admin.id);
  invalidateLocalUserCache();
  clearAuthModeCache();

  // Same invariant as bootstrap-admin: an admin exists, so this box can own its
  // "This Server" row. The free-domain install lands HERE and not there —
  // cloud-connect runs first and mirrors the cloud user into a real admin, so
  // bootstrap-admin 409s and the CLI falls back to this endpoint. Hanging
  // registration off bootstrap alone is what left those boxes with no server.
  await ensureLocalServer().catch((err) =>
    console.warn("[setup] local server registration deferred to next boot:", safeErrorMessage(err)),
  );

  // The admin's personal org (org_<id>) is created by provisionUser, so record
  // against it — the literal "instance" has no organization row and the audit
  // insert would fail its FK (event silently dropped).
  audit.recordAsync(auditContextFrom(c, `org_${admin.id}`, admin.id), {
    eventType: "admin.password_reset",
    resourceType: "instance-settings",
    resourceId: "instance",
    after: { userId: admin.id, email },
  });

  return c.json({ ok: true, email });
}

// ── Auth upgrade (zero-auth → local-auth) ────────────────────────────────────

/**
 * POST /system/upgrade-to-auth — promote the synthetic zero-auth user
 * to a real email/password account.
 *
 * Only callable while `authMode === "none"`. Steps:
 *
 *   1. Locate the existing local user via ensureLocalUser (preserves
 *      userId so every existing FK — projects, deployments, member,
 *      audit — keeps resolving).
 *   2. UPDATE user.{name,email,emailVerified,autoProvisioned=false}.
 *   3. Insert a credential-provider account row with the hashed
 *      password (Better Auth's own hasher).
 *   4. If `useOwnMailServer === true` and a provisioned mail server
 *      exists, ensureOpenshipPlatformMailbox(serverId) so the platform
 *      transport is ready for the new login emails.
 *   5. Flip instanceSettings.authMode "none" → "local" (audit row).
 *   6. Mint a Better Auth session and stamp the response cookie so the
 *      browser stays signed in across the redirect.
 *
 * Reversible up to step 5: any failure before the authMode flip leaves
 * the instance in zero-auth mode and the operator can retry.
 */
export async function upgradeToAuth(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;

  // PUBLIC route (no session exists yet) → it MUST enforce the same zero-auth
  // guardrails authMiddleware does. Using the shared guard (canonical authMode
  // default + loopback + opt-in) closes the CWE-306 takeover: a fresh, network-
  // reachable self-hosted install now resolves to "local" (not "none"), and a
  // non-loopback peer can never bootstrap the first admin.
  const gate = await zeroAuthAllowed(c);
  if (!gate.ok) {
    console.warn(`[upgradeToAuth] refused: ${gate.reason}`);
    return c.json(
      { error: "Auth upgrade is only available from a loopback zero-auth (desktop) instance." },
      400,
    );
  }

  const body = (await c.req.json()) as {
    name?: unknown;
    email?: unknown;
    password?: unknown;
    useOwnMailServer?: unknown;
  };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const useOwnMailServer = body.useOwnMailServer === true;

  if (!name || name.length < 1 || name.length > 100) {
    return c.json({ error: "name is required (1-100 chars)" }, 400);
  }
  if (!email || !email.includes("@") || email.length > 254) {
    return c.json({ error: "email must be a valid address" }, 400);
  }
  if (password.length < 8 || password.length > 128) {
    return c.json({ error: "password must be 8-128 characters" }, 400);
  }

  // Reject if the email collides with an OTHER user (we DO allow it to
  // collide with the local synthetic user — that's the row we're
  // rewriting).
  const existingByEmail = await repos.user.findByEmail(email);
  const localUser = await ensureLocalUser();
  if (existingByEmail && existingByEmail.id !== localUser.id) {
    return c.json({ error: "An account with this email already exists" }, 409);
  }

  const hashed = await hashPassword(password);

  // 1+2+3. Update user + insert credential account in one transaction.
  await db.transaction(async (tx) => {
    await tx
      .update(schema.user)
      .set({
        name,
        email,
        emailVerified: true,
        autoProvisioned: false,
        updatedAt: new Date(),
      })
      .where(eq(schema.user.id, localUser.id));

    // Better Auth's credential provider expects providerId="credential",
    // accountId=userId, and the bcrypt-style hash in `password`. There
    // should be no prior credential row for the zero-auth user; guard
    // by deleting any existing credential row first to keep the call
    // idempotent on retry.
    await tx
      .delete(schema.account)
      .where(
        and(eq(schema.account.userId, localUser.id), eq(schema.account.providerId, "credential")),
      );

    await tx.insert(schema.account).values({
      id: generateId("acc"),
      accountId: localUser.id,
      providerId: "credential",
      userId: localUser.id,
      password: hashed,
    });

    // 5. Flip authMode "none" → "local".
    await tx
      .insert(schema.instanceSettings)
      .values({ id: "default", authMode: "local" })
      .onConflictDoUpdate({
        target: schema.instanceSettings.id,
        set: { authMode: "local", updatedAt: new Date() },
      });
  });

  invalidateLocalUserCache();
  clearAuthModeCache();

  // 4. Best-effort: warm the platform mailbox if requested. We don't
  //    fail the upgrade if this errors — sendMail() will fall back to
  //    env-based transport on subsequent emails.
  if (useOwnMailServer) {
    try {
      const mailServers = await repos.mailServer.list();
      const installed = mailServers.find((m) => m.installedAt != null);
      if (installed) {
        const { ensureOpenshipPlatformMailbox } =
          await import("../mail/admin/platform-mailbox.service");
        await ensureOpenshipPlatformMailbox(installed.serverId);
        invalidatePlatformTransport();
      }
    } catch (err) {
      console.warn("[upgradeToAuth] platform mailbox warm-up failed:", err);
    }
  }

  // Audit the mode flip.
  audit.recordAsync(auditContextFrom(c, "instance", localUser.id), {
    eventType: "auth-mode-changed",
    resourceType: "instance-settings",
    resourceId: "instance",
    before: { authMode: "none" },
    after: { authMode: "local", upgradedUserId: localUser.id, email },
  });

  // 6. Mint a fresh session so the browser stays signed in.
  const ipAddress = c.req.header("x-forwarded-for") ?? "127.0.0.1";
  const userAgent = c.req.header("user-agent") ?? "upgrade";
  const session = await mintSession({
    purpose: "local-cookie",
    userId: localUser.id,
    ipAddress,
    userAgent,
  });
  await setSignedCookie(
    c,
    `${COOKIE_PREFIX}.session_token`,
    session.token,
    env.BETTER_AUTH_SECRET,
    {
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
      path: "/",
      expires: session.expiresAt,
    },
  );

  return c.json({
    ok: true,
    authMode: "local",
    user: { id: localUser.id, name, email },
  });
}

/**
 * POST /system/onboarding - first-run setup from dashboard/browser.
 *
 * Same logic as `setup()`, but only allowed when the instance has
 * no servers configured yet. This avoids requiring auth tokens for
 * the initial onboarding flow (desktop, CLI, or direct browser).
 *
 * After the first server is created this endpoint returns 403.
 */
export async function onboardingSetup(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;

  const servers = await repos.server.list();
  if (servers.length > 0) {
    return c.json({ error: "Instance already configured" }, 403);
  }

  // Delegate to the shared setup logic
  return setup(c);
}

/**
 * GET /system/telemetry - live control plane metrics and health for Settings.
 */
export async function getControlPlaneTelemetry(c: Context) {
  const os = await import("node:os");
  const mem = process.memoryUsage();
  const cpus = os.cpus();
  const load = os.loadavg();
  const uptime = process.uptime();
  const hostUptime = os.uptime();

  return c.json({
    ok: true,
    telemetry: {
      uptimeSeconds: Math.round(uptime),
      hostUptimeSeconds: Math.round(hostUptime),
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
        systemTotalMb: Math.round(os.totalmem() / 1024 / 1024),
        systemFreeMb: Math.round(os.freemem() / 1024 / 1024),
      },
      cpu: {
        cores: cpus.length,
        model: cpus[0]?.model ?? "Unknown",
        loadAvg: load,
      },
      process: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
      },
    },
  });
}

/** GET /system/dashboard-domain - read configured dashboard root domain */
export async function getDashboardDomain(c: Context) {
  const settings = await repos.instanceSettings.get();
  return c.json({
    data: {
      dashboardDomain: settings?.dashboardDomain ?? null,
      dashboardSslStatus: settings?.dashboardSslStatus ?? "none",
      dashboardDnsZoneId: settings?.dashboardDnsZoneId ?? null,
      dashboardDnsRecordId: settings?.dashboardDnsRecordId ?? null,
    },
  });
}

/** POST /system/dashboard-domain - configure custom dashboard root domain */
export async function setDashboardDomain(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{
    domain: string;
    autoDns?: boolean;
    dnsCredentialId?: string;
  }>();

  const domain = body.domain?.trim().toLowerCase();
  if (!domain) {
    return c.json({ error: "Domain is required" }, 400);
  }

  let dnsZoneId: string | undefined;
  let dnsRecordId: string | undefined;

  if (body.autoDns) {
    const creds = await dnsCredentialService.listCredentials(ctx.organizationId);
    const targetCred = body.dnsCredentialId
      ? creds.find((cred) => cred.id === body.dnsCredentialId)
      : creds.find((cred) => cred.provider === "cloudflare");

    if (targetCred) {
      const serverIp = env.SERVER_IP || "127.0.0.1";
      const decrypted = await dnsCredentialService.resolveDecryptedCredential(
        ctx.organizationId,
        targetCred.id,
      );

      if (decrypted) {
        try {
          const zone = await cloudflareDnsProvider.findZone(decrypted, domain);
          if (zone) {
            dnsZoneId = zone.id;
            const record = await cloudflareDnsProvider.upsertRecord(decrypted, zone.id, {
              type: "A",
              name: domain,
              content: serverIp,
              proxied: false,
              ttl: 1,
            });
            dnsRecordId = record.id;
          }
        } catch (err) {
          console.warn("[DashboardDomain] Failed to auto-provision DNS record:", err);
        }
      }
    }
  }

  const updated = await repos.instanceSettings.upsert({
    dashboardDomain: domain,
    dashboardDnsZoneId: dnsZoneId,
    dashboardDnsRecordId: dnsRecordId,
    dashboardSslStatus: "pending",
  });

  return c.json({
    data: {
      dashboardDomain: updated.dashboardDomain,
      dashboardSslStatus: updated.dashboardSslStatus,
      dashboardDnsZoneId: updated.dashboardDnsZoneId,
      dashboardDnsRecordId: updated.dashboardDnsRecordId,
    },
  });
}

/** DELETE /system/dashboard-domain - remove custom dashboard root domain */
export async function deleteDashboardDomain(c: Context) {
  const ctx = getRequestContext(c);
  const settings = await repos.instanceSettings.get();

  if (settings?.dashboardDnsZoneId && settings?.dashboardDnsRecordId) {
    try {
      const creds = await dnsCredentialService.listCredentials(ctx.organizationId);
      const cfCred = creds.find((cred) => cred.provider === "cloudflare");
      if (cfCred) {
        const decrypted = await dnsCredentialService.resolveDecryptedCredential(
          ctx.organizationId,
          cfCred.id,
        );
        if (decrypted) {
          await cloudflareDnsProvider.deleteRecord(
            decrypted,
            settings.dashboardDnsZoneId,
            settings.dashboardDnsRecordId,
          );
        }
      }
    } catch (err) {
      console.warn("[DashboardDomain] Failed to delete DNS record:", err);
    }
  }

  const updated = await repos.instanceSettings.upsert({
    dashboardDomain: null,
    dashboardDnsZoneId: null,
    dashboardDnsRecordId: null,
    dashboardSslStatus: "none",
  });

  return c.json({ data: updated });
}

>>>>>>> feat/ports-multi-wildcard-domains-and-cloudflare-oauth
