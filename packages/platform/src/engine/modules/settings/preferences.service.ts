import type { ExecutionContext } from "../../../context";
import type { Static } from "@sinclair/typebox";
import { UserSettingsSchemas, ValidationError } from "@repo/contracts";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { repos } from "@repo/db";
import { randomBytes } from "node:crypto";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import {
  getBuildMode,
  getDeployDefaults,
  isValidDefaultDeployTarget,
  getTransferPrefs,
  isValidTransferMode,
  isValidTransferCompression,
  getRouteStrategy,
  isValidRouteStrategy,
  getForwardGitToServer,
  setForwardGitToServer,
  type BuildMode,
} from "@repo/platform/engine/modules/settings/settings.service";

const VALID_CLONE_STRATEGY_PREFERENCES = ["prompt", "local", "remote-with-token"] as const;
type CloneStrategyPreference = (typeof VALID_CLONE_STRATEGY_PREFERENCES)[number];

const VALID_MODES: BuildMode[] = ["auto", "server", "local"];

function generateId() {
  return "us_" + randomBytes(12).toString("base64url");
}

/** GET / - return platform settings for the authenticated user */
export async function get(ctx: ExecutionContext) {
  const [buildMode, deployDefaults, cloneCreds, transferPrefs, routeStrategy, forwardGitToServer] =
    await Promise.all([
      getBuildMode(ctx.userId),
      getDeployDefaults(ctx.userId),
      getCloneCredentialsState(ctx.userId),
      getTransferPrefs(ctx.userId),
      getRouteStrategy(ctx.userId),
      getForwardGitToServer(ctx.userId),
    ]);
  return ({
    buildMode,
    ...deployDefaults,
    ...cloneCreds,
    ...transferPrefs,
    routeStrategy,
    forwardGitToServer,
  });
}

/**
 * PATCH /forward-git - flip the generic "forward my git identity to remote build
 * servers" preference. This is the per-operator replacement for the old
 * per-deploy `forwardGitCredentials` toggle: when on, a server clone may forward
 * the local `gh` over the SSH tunnel; when off, the clone falls back to the
 * server's own ambient git / stored token / public / clone-local chain.
 *
 * Body: { enabled: boolean }
 */
export async function updateForwardGitToServer(ctx: ExecutionContext, body: Static<typeof UserSettingsSchemas.setGitForwarding.input>) {
  if (typeof body?.enabled !== "boolean") {
    throw new ValidationError("enabled must be a boolean");
  }

  await setForwardGitToServer(ctx.userId, body.enabled);

  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "settings.updated",
    resourceType: "settings",
    resourceId: ctx.userId,
    after: { action: "forwardGitToServer.set", forwardGitToServer: body.enabled },
  });

  return ({ forwardGitToServer: body.enabled });
}

/** PATCH /route-strategy - update just the edge→app route strategy default */
export async function updateRouteStrategy(ctx: ExecutionContext, body: Static<typeof UserSettingsSchemas.setRouteStrategy.input>) {
  const { routeStrategy } = body;

  if (!isValidRouteStrategy(routeStrategy)) {
    throw new ValidationError("routeStrategy must be 'auto', 'loopback-port', or 'container-ip'");
  }

  const existing = await repos.settings.findByUser(ctx.userId);
  if (!existing) {
    await repos.settings.upsert({ id: generateId(), userId: ctx.userId, routeStrategy });
  } else {
    await repos.settings.update(ctx.userId, { routeStrategy });
  }

  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "settings.updated",
    resourceType: "settings",
    resourceId: ctx.userId,
    after: { action: "routeStrategy.set", routeStrategy },
  });

  return ({ routeStrategy });
}

/**
 * Read-only view of the user's clone credentials state for the dashboard.
 * Never returns the token itself - only `hasToken` + when it was set + the
 * "use as default" flag + the saved strategy preference. The token only
 * leaves the server during clone, never via API responses.
 */
async function getCloneCredentialsState(userId: string) {
  const settings = await repos.settings.findByUser(userId).catch(() => null);
  return {
    cloneToken: {
      hasToken: !!settings?.cloneTokenEncrypted,
      setAt: settings?.cloneTokenSetAt?.toISOString() ?? null,
      asDefault: settings?.cloneTokenAsDefault ?? false,
    },
    cloneStrategyPreference: (settings?.cloneStrategyPreference ?? "prompt") as CloneStrategyPreference,
  };
}

/** PUT / - create or update platform settings */
export async function upsert(ctx: ExecutionContext, body: Static<typeof UserSettingsSchemas.update.input>) {

  const buildMode = body.buildMode || "auto";
  if (!VALID_MODES.includes(buildMode)) {
    throw new ValidationError("buildMode must be 'auto', 'server', or 'local'");
  }

  const row = await repos.settings.upsert({
    id: generateId(),
    userId: ctx.userId,
    buildMode,
  });

  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "settings.updated",
    resourceType: "settings",
    resourceId: ctx.userId,
    after: {
      buildMode: row.buildMode,
      defaultDeployTarget: isValidDefaultDeployTarget(row.defaultDeployTarget)
        ? row.defaultDeployTarget
        : null,
      defaultServerId: row.defaultServerId ?? null,
    },
  });

  return ({
    buildMode: row.buildMode,
    defaultDeployTarget: isValidDefaultDeployTarget(row.defaultDeployTarget)
      ? row.defaultDeployTarget
      : null,
    defaultServerId: row.defaultServerId ?? null,
  });
}

/** PATCH /build-mode - update just the build mode preference */
export async function updateBuildMode(ctx: ExecutionContext, body: Static<typeof UserSettingsSchemas.setBuildMode.input>) {
  const { buildMode } = body;

  if (!VALID_MODES.includes(buildMode)) {
    throw new ValidationError("buildMode must be 'auto', 'server', or 'local'");
  }

  const existing = await repos.settings.findByUser(ctx.userId);
  if (!existing) {
    await repos.settings.upsert({ id: generateId(), userId: ctx.userId, buildMode });
  } else {
    await repos.settings.update(ctx.userId, { buildMode });
  }

  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "settings.updated",
    resourceType: "settings",
    resourceId: ctx.userId,
    after: { action: "buildMode.set", buildMode },
  });

  return ({ buildMode });
}

/**
 * PATCH /deploy-defaults - set/clear the user's default deploy target.
 *
 * Body shape:
 *   { defaultDeployTarget: "server" | "cloud" | null,
 *     defaultServerId?: string | null }
 *
 * Pass nulls to clear. When target="server", defaultServerId is required;
 * for other targets the server id is forced to null on the server side so
 * the row doesn't carry a stale association.
 */
export async function updateDeployDefaults(ctx: ExecutionContext, body: Static<typeof UserSettingsSchemas.setDeployDefaults.input>) {

  const rawTarget = body?.defaultDeployTarget;
  const target = rawTarget === null || rawTarget === undefined
    ? null
    : (isValidDefaultDeployTarget(rawTarget) ? rawTarget : "__invalid__");

  if (target === "__invalid__") {
    throw new ValidationError("defaultDeployTarget must be 'server', 'cloud', or null");
  }

  let serverId: string | null = null;
  if (target === "server") {
    const rawServerId = body?.defaultServerId;
    if (typeof rawServerId !== "string" || !rawServerId) {
      throw new ValidationError("defaultServerId is required when defaultDeployTarget='server'");
    }
    serverId = rawServerId;
  }

  const existing = await repos.settings.findByUser(ctx.userId);
  if (!existing) {
    await repos.settings.upsert({
      id: generateId(),
      userId: ctx.userId,
      buildMode: "auto",
      defaultDeployTarget: target,
      defaultServerId: serverId,
    });
  } else {
    await repos.settings.update(ctx.userId, {
      defaultDeployTarget: target,
      defaultServerId: serverId,
    });
  }

  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "settings.updated",
    resourceType: "settings",
    resourceId: ctx.userId,
    after: {
      action: "deployDefaults.set",
      defaultDeployTarget: target,
      defaultServerId: serverId,
    },
  });

  return ({ defaultDeployTarget: target, defaultServerId: serverId });
}

/**
 * PATCH /clone-credentials - set/replace/clear the user-global clone token.
 *
 * Body:
 *   { token?: string | null, asDefault?: boolean }
 *
 *   token === null  → clear the stored token (also clears asDefault).
 *   token: string   → encrypt and store. Empty string is treated as clear.
 *   asDefault       → opt-in flag. If false, the stored token won't be used
 *                     by `resolveCloneToken` (still useful as a one-off
 *                     value the user can ship per-deploy via UI).
 *
 * Returns the read-only state (never the token itself).
 */
export async function updateCloneCredentials(ctx: ExecutionContext, body: Static<typeof UserSettingsSchemas.setCloneCredentials.input>) {

  const rawToken = body?.token;
  const clearing = rawToken === null || rawToken === "";
  const setting = typeof rawToken === "string" && rawToken.length > 0;
  if (!clearing && !setting && rawToken !== undefined) {
    throw new ValidationError("token must be a string, null, or omitted");
  }

  const asDefault = body?.asDefault === true;

  const existing = await repos.settings.findByUser(ctx.userId);
  const updates: Partial<{
    cloneTokenEncrypted: string | null;
    cloneTokenSetAt: Date | null;
    cloneTokenAsDefault: boolean;
  }> = {};

  if (clearing) {
    updates.cloneTokenEncrypted = null;
    updates.cloneTokenSetAt = null;
    updates.cloneTokenAsDefault = false;
  } else if (setting) {
    updates.cloneTokenEncrypted = encrypt(rawToken);
    updates.cloneTokenSetAt = new Date();
    updates.cloneTokenAsDefault = asDefault;
  } else if (rawToken === undefined && body?.asDefault !== undefined) {
    // Token-untouched, just flipping the asDefault flag.
    updates.cloneTokenAsDefault = asDefault;
  }

  if (!existing) {
    await repos.settings.upsert({
      id: generateId(),
      userId: ctx.userId,
      buildMode: "auto",
      ...updates,
    });
  } else {
    await repos.settings.update(ctx.userId, updates);
  }

  // Audit signal only - never include the token itself or even the
  // ciphertext. Just whether a token is now stored + the asDefault flag.
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "settings.updated",
    resourceType: "settings",
    resourceId: ctx.userId,
    after: {
      action: clearing
        ? "cloneCredentials.cleared"
        : setting
          ? "cloneCredentials.set"
          : "cloneCredentials.asDefaultUpdated",
      asDefault: updates.cloneTokenAsDefault ?? null,
    },
  });

  return (await getCloneCredentialsState(ctx.userId));
}

/**
 * PATCH /clone-strategy-preference - save the user's first-time-deploy choice.
 *
 * Body: { preference: "prompt" | "local" | "remote-with-token" }
 *
 * Once set to anything other than "prompt", the deploy nudge stops asking.
 */
export async function updateCloneStrategyPreference(ctx: ExecutionContext, body: Static<typeof UserSettingsSchemas.setCloneStrategy.input>) {
  const pref = body?.preference;
  if (!VALID_CLONE_STRATEGY_PREFERENCES.includes(pref)) {
    throw new ValidationError(`preference must be one of: ${VALID_CLONE_STRATEGY_PREFERENCES.join(", ")}`);
  }

  const existing = await repos.settings.findByUser(ctx.userId);
  if (!existing) {
    await repos.settings.upsert({
      id: generateId(),
      userId: ctx.userId,
      buildMode: "auto",
      cloneStrategyPreference: pref,
    });
  } else {
    await repos.settings.update(ctx.userId, { cloneStrategyPreference: pref });
  }
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "settings.updated",
    resourceType: "settings",
    resourceId: ctx.userId,
    after: { action: "cloneStrategyPreference.set", cloneStrategyPreference: pref },
  });
  return ({ cloneStrategyPreference: pref });
}

/** PATCH /transfer - set the volume-transfer mode/compression preference. */
export async function updateTransferPrefs(ctx: ExecutionContext, body: Static<typeof UserSettingsSchemas.setTransferPreferences.input>) {
  const patch: { transferMode?: string; transferCompression?: string } = {};
  if (body?.transferMode !== undefined) {
    if (!isValidTransferMode(body.transferMode)) {
      throw new ValidationError("transferMode must be one of: auto, stream, direct, rsync");
    }
    patch.transferMode = body.transferMode;
  }
  if (body?.transferCompression !== undefined) {
    if (!isValidTransferCompression(body.transferCompression)) {
      throw new ValidationError("transferCompression must be one of: auto, zstd, gzip, none");
    }
    patch.transferCompression = body.transferCompression;
  }
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("provide transferMode and/or transferCompression");
  }

  const existing = await repos.settings.findByUser(ctx.userId);
  if (!existing) {
    await repos.settings.upsert({ id: generateId(), userId: ctx.userId, buildMode: "auto", ...patch });
  } else {
    await repos.settings.update(ctx.userId, patch);
  }
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "settings.updated",
    resourceType: "settings",
    resourceId: ctx.userId,
    after: { action: "transferPrefs.set", ...patch },
  });
  return (await getTransferPrefs(ctx.userId));
}
