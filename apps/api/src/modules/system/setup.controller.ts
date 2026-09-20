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

import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { getSetup as readSetup, validateAuthModeChange } from "@repo/platform/engine/modules/system/settings.operations";
import { operationContext, operationData } from "../../lib/operation-context";
import type { Context } from "hono";
import { setSignedCookie } from "hono/cookie";
import { db, repos, schema, eq, and } from "@repo/db";
import { generateId, normalizeRollbackWindow, safeErrorMessage } from "@repo/core";
import { hashPassword } from "better-auth/crypto";
import { invalidateOpenRestyPaths } from "@repo/platform/engine/lib/openresty-paths";
import { env } from "@repo/platform/engine/config/index";
import { audit, auditContextFrom } from "../../lib/audit";
import { getRequestContext } from "../../lib/request-context";
import {
  clearAuthModeCache,
  pinnedAuthMode,
} from "@repo/platform/engine/lib/auth-mode";
import { assertNotCloud } from "../../lib/controller-helpers";
import { assertInstanceAdmin } from "../../middleware/instance-admin";
import { zeroAuthAllowed } from "../../middleware/zero-auth-guard";
import { sshManager } from "@repo/platform/engine/lib/ssh-manager";
import { encryptSecretField } from "@repo/platform/engine/lib/credential-encryption";
import { ensureLocalUser, invalidateLocalUserCache } from "../../lib/local-user";
import { ensureLocalServer } from "@repo/platform/engine/lib/startup/self-server";
import { provisionUser } from "@repo/platform/engine/lib/provision-user";
import { COOKIE_PREFIX } from "@repo/platform/engine/lib/auth";
import { mintSession } from "../../lib/cloud-auth-proxy";
import { invalidatePlatformTransport } from "@repo/platform/engine/lib/mail";



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
  return c.json(await operationData(c, getPlatformKernel().system.getSettings(operationContext(c))));
}

/** Host-token setup read has no user session; the route requires internalAuth. */
export async function getInternalSetup(c: Context) {
  return c.json(await readSetup());
}

/** PATCH /system/settings - partial update instance-level settings (non-SSH) */
export async function updateSettings(c: Context) {
  return c.json(await operationData(c, getPlatformKernel().system.updateSettings(operationContext(c), await c.req.json())));
}

// ─── Instance SMTP (Settings → Email) ────────────────────────────────────────


/**
 * GET /system/settings/email — the instance SMTP config, MASKED. The password
 * is never returned; `hasPassword` tells the UI whether one is stored so it can
 * offer "leave blank to keep".
 */
export async function getEmailSettings(c: Context) {
  return c.json(await operationData(c, getPlatformKernel().system.getEmailSettings(operationContext(c))));
}

/**
 * PUT /system/settings/email — set (or clear) the instance SMTP config. The
 * password is encrypted at rest; an omitted/blank password KEEPS the stored one
 * (the client never receives it to echo back). An empty host clears the whole
 * config (disables instance SMTP). Invalidates the mail transport cache so the
 * next send picks up the change.
 */
export async function updateEmailSettings(c: Context) {
  return c.json(await operationData(c, getPlatformKernel().system.updateEmailSettings(operationContext(c), await c.req.json())));
}

/**
 * POST /system/settings/email/test — send a test message through the saved
 * instance SMTP. Surfaces the real transport error (wrong host/port/creds) so
 * the operator can fix it before relying on it for password resets.
 */
export async function sendTestEmail(c: Context) {
  const result = await operationData(c, getPlatformKernel().system.sendTestEmail(operationContext(c), await c.req.json()));
  return c.json(result, result.ok ? 200 : 400);
}

/** DELETE /system/settings - remove server configuration */
export async function deleteSettings(c: Context) {
  return c.json(await operationData(c, getPlatformKernel().system.resetSettings(operationContext(c))));
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
          await import("@repo/platform/engine/modules/mail/admin/platform-mailbox.service");
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
