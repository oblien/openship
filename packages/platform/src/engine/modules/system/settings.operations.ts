/** Instance settings logic retained from the HTTP setup controller. */
import type { ExecutionContext } from "../../../context";
import { OperationError, type SystemOperations, type UpdateInstanceSettingsInput, type UpdateInstanceEmailSettingsInput } from "@repo/contracts";
import { repos } from "@repo/db";
import { normalizeRollbackWindow } from "@repo/core";
import { env } from "../../config";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { AUTH_MODES, clearAuthModeCache, pinnedAuthMode, type AuthMode as AuthModeType } from "../../lib/auth-mode";
import { PRODUCT_MODES, clearProductModeCache, isProductMode, resolveProductMode } from "../../lib/product-mode";
import { clearHostControlCache, resolveHostControlEnabled, syncHostControlOverride } from "../../lib/host-control";
import { boxOwningOrgId } from "../../lib/box-org";
import { encrypt } from "../../lib/encryption";
import { sendInstanceTestEmail, invalidateInstanceTransportCache, canSendMail } from "../../lib/mail";
import { getInstanceReachability } from "../../lib/public-url";
import { sshManager } from "../../lib/ssh-manager";
import { ensureLocalServer } from "../../lib/startup/self-server";
import { invalidateOpenRestyPaths } from "../../lib/openresty-paths";
import { assertSelfHosted } from "./server-access";

function failSettings(body: { error: string }, status: number): never {
  throw new OperationError(body.error, status, "INVALID_INSTANCE_SETTINGS", body);
}
const SMTP_HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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
export function validateAuthModeChange(body: Record<string, unknown>): AuthModeValidation {
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

export async function getSetup(): Promise<Awaited<ReturnType<SystemOperations["getSettings"]>>> {
  assertSelfHosted();

  const settings = await repos.instanceSettings.get();
  const servers = await repos.server.list();
  const hasServer = servers.length > 0;
  // Source-of-truth for "can teammates reach this instance + at what URL" —
  // drives the smart team-invite gate + its inline guidance (see TeamTab).
  const teamReachability = await getInstanceReachability().catch(() => null);

  return {
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
  };
}

export async function updateSettings(ctx: ExecutionContext, body: UpdateInstanceSettingsInput): Promise<Awaited<ReturnType<SystemOperations["updateSettings"]>>> {
  assertSelfHosted();

  // The shared system operation verifies the persisted instance role before
  // entering this implementation, for both HTTP and native callers.
  // Only instance-level fields - SSH changes go through the servers API.
  const patch: Record<string, unknown> = {};

  // authMode changes are security-sensitive: validate against the canonical
  // set, enforce the zero-auth safety gate, and capture the previous value
  // for the audit row written after the upsert succeeds.
  let authModeChange: { before: AuthMode | null; after: AuthMode } | null = null;
  if (body.authMode !== undefined) {
    const validation = validateAuthModeChange(body);
    if (!validation.ok) {
      return failSettings(validation.body, validation.status);
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
      return failSettings({ error: "invitationMailSource must be 'platform' or 'cloud'" }, 400);
    }
    patch.invitationMailSource = raw;
  }
  if (body.autoUpdateInfra !== undefined) patch.autoUpdateInfra = Boolean(body.autoUpdateInfra);
  if (body.autoScanInfra !== undefined) patch.autoScanInfra = Boolean(body.autoScanInfra);
  // Openship Mail. `null` clears the override so OPENSHIP_PRODUCT governs again —
  // that's a meaningful state, not an absent field, so it's accepted explicitly.
  if (body.productMode !== undefined) {
    if (body.productMode !== null && !isProductMode(body.productMode)) {
      return failSettings({ error: `productMode must be one of: ${PRODUCT_MODES.join(", ")}, or null` }, 400);
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
      return failSettings({ error: "hostControl must be true, false, or null" }, 400);
    }
    if (ctx.organizationId !== (await boxOwningOrgId())) {
      return failSettings({ error: "Only the owner of this machine's workspace can change host control." }, 403);
    }
    patch.hostControlEnabled = body.hostControl;
  }

  if (Object.keys(patch).length === 0) {
    return failSettings({ error: "No fields to update" }, 400);
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
    audit.recordAsync(operationAuditContext(ctx), {
      eventType: "auth-mode-changed",
      resourceType: "instance-settings",
      resourceId: "instance",
      before: { authMode: authModeChange.before },
      after: { authMode: authModeChange.after },
    });
  }

  return { ok: true };
}

export async function getEmailSettings(ctx: ExecutionContext): Promise<Awaited<ReturnType<SystemOperations["getEmailSettings"]>>> {
  assertSelfHosted();
  const s = await repos.instanceSettings.get();
  const configured = !!(s?.smtpHost && s?.smtpUser && s?.smtpPasswordEncrypted);
  return {
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
  };
}

export async function updateEmailSettings(ctx: ExecutionContext, body: UpdateInstanceEmailSettingsInput): Promise<Awaited<ReturnType<SystemOperations["updateEmailSettings"]>>> {
  assertSelfHosted();

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
    return { ok: true, configured: false };
  }

  if (!SMTP_HOST_RE.test(host)) return failSettings({ error: "Invalid SMTP host" }, 400);

  const user = typeof body.user === "string" ? body.user.trim() : "";
  if (!user) return failSettings({ error: "SMTP username is required" }, 400);

  const portRaw =
    body.port === undefined || body.port === null || body.port === "" ? 587 : Number(body.port);
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    return failSettings({ error: "Invalid SMTP port" }, 400);
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
    return failSettings({ error: "SMTP password is required" }, 400);
  }

  await repos.instanceSettings.upsert({
    smtpHost: host,
    smtpPort: portRaw,
    smtpUser: user,
    smtpPasswordEncrypted,
    smtpFrom: from,
  });
  invalidateInstanceTransportCache();
  return { ok: true, configured: true };
}

export async function sendTestEmail(ctx: ExecutionContext, body: { to: string }): Promise<Awaited<ReturnType<SystemOperations["sendTestEmail"]>>> {
  assertSelfHosted();

  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (!to || !EMAIL_RE.test(to)) {
    return failSettings({ error: "A valid recipient email is required" }, 400);
  }

  try {
    await sendInstanceTestEmail(to);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send test email";
    return { ok: false, error: message };
  }
}

export async function deleteSettings(ctx: ExecutionContext): Promise<Awaited<ReturnType<SystemOperations["resetSettings"]>>> {
  assertSelfHosted();

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
  clearProductModeCache();
  invalidateInstanceTransportCache();
  // The row just dropped held host_control_enabled (#527). Without reconciling here
  // the cached effective value and the pushed adapters override would both survive
  // the delete and keep serving the deleted choice until the next boot — so re-sync
  // to let the OPENSHIP_HOST_CONTROL env floor govern again.
  clearHostControlCache();
  await syncHostControlOverride().catch(() => {});
  return { ok: true };
}
