import type { Context } from "hono";
import { getRequestContext } from "../../lib/request-context";
import { audit, auditContextFrom } from "../../lib/audit";
import { repos } from "@repo/db";
import { randomBytes } from "node:crypto";
import { encrypt } from "../../lib/encryption";
import {
  getBuildMode,
  getDeployDefaults,
  isValidDefaultDeployTarget,
  getTransferPrefs,
  isValidTransferMode,
  isValidTransferCompression,
  getRouteStrategy,
  isValidRouteStrategy,
  type BuildMode,
} from "./settings.service";

const VALID_CLONE_STRATEGY_PREFERENCES = ["prompt", "local", "remote-with-token"] as const;
type CloneStrategyPreference = (typeof VALID_CLONE_STRATEGY_PREFERENCES)[number];

const VALID_MODES: BuildMode[] = ["auto", "server", "local"];

function generateId() {
  return "us_" + randomBytes(12).toString("base64url");
}

/** GET / - return platform settings for the authenticated user */
export async function get(c: Context) {
  const ctx = getRequestContext(c);
  const [buildMode, deployDefaults, cloneCreds, transferPrefs, routeStrategy] = await Promise.all([
    getBuildMode(ctx.userId),
    getDeployDefaults(ctx.userId),
    getCloneCredentialsState(ctx.userId),
    getTransferPrefs(ctx.userId),
    getRouteStrategy(ctx.userId),
  ]);
  return c.json({ buildMode, ...deployDefaults, ...cloneCreds, ...transferPrefs, routeStrategy });
}

/** PATCH /route-strategy - update just the edge→app route strategy default */
export async function updateRouteStrategy(c: Context) {
  const ctx = getRequestContext(c);
  const { routeStrategy } = await c.req.json();

  if (!isValidRouteStrategy(routeStrategy)) {
    return c.json(
      { error: "routeStrategy must be 'auto', 'loopback-port', or 'container-ip'" },
      400,
    );
  }

  const existing = await repos.settings.findByUser(ctx.userId);
  if (!existing) {
    await repos.settings.upsert({ id: generateId(), userId: ctx.userId, routeStrategy });
  } else {
    await repos.settings.update(ctx.userId, { routeStrategy });
  }

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "settings.updated",
    resourceType: "settings",
    resourceId: ctx.userId,
    after: { action: "routeStrategy.set", routeStrategy },
  });

  return c.json({ routeStrategy });
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
export async function upsert(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json();

  const buildMode = body.buildMode || "auto";
  if (!VALID_MODES.includes(buildMode)) {
    return c.json({ error: "buildMode must be 'auto', 'server', or 'local'" }, 400);
  }

  const row = await repos.settings.upsert({
    id: generateId(),
    userId: ctx.userId,
    buildMode,
  });

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
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

  return c.json({
    buildMode: row.buildMode,
    defaultDeployTarget: isValidDefaultDeployTarget(row.defaultDeployTarget)
      ? row.defaultDeployTarget
      : null,
    defaultServerId: row.defaultServerId ?? null,
  });
}

/** PATCH /build-mode - update just the build mode preference */
export async function updateBuildMode(c: Context) {
  const ctx = getRequestContext(c);
  const { buildMode } = await c.req.json();

  if (!VALID_MODES.includes(buildMode)) {
    return c.json({ error: "buildMode must be 'auto', 'server', or 'local'" }, 400);
  }

  const existing = await repos.settings.findByUser(ctx.userId);
  if (!existing) {
    await repos.settings.upsert({ id: generateId(), userId: ctx.userId, buildMode });
  } else {
    await repos.settings.update(ctx.userId, { buildMode });
  }

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "settings.updated",
    resourceType: "settings",
    resourceId: ctx.userId,
    after: { action: "buildMode.set", buildMode },
  });

  return c.json({ buildMode });
}

/**
 * PATCH /deploy-defaults - set/clear the user's default deploy target.
 *
 * Body shape:
 *   { defaultDeployTarget: "local" | "server" | "cloud" | null,
 *     defaultServerId?: string | null }
 *
 * Pass nulls to clear. When target="server", defaultServerId is required;
 * for other targets the server id is forced to null on the server side so
 * the row doesn't carry a stale association.
 */
export async function updateDeployDefaults(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json().catch(() => ({}));

  const rawTarget = body?.defaultDeployTarget;
  const target = rawTarget === null || rawTarget === undefined
    ? null
    : (isValidDefaultDeployTarget(rawTarget) ? rawTarget : "__invalid__");

  if (target === "__invalid__") {
    return c.json(
      { error: "defaultDeployTarget must be 'local', 'server', 'cloud', or null" },
      400,
    );
  }

  let serverId: string | null = null;
  if (target === "server") {
    const rawServerId = body?.defaultServerId;
    if (typeof rawServerId !== "string" || !rawServerId) {
      return c.json(
        { error: "defaultServerId is required when defaultDeployTarget='server'" },
        400,
      );
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

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "settings.updated",
    resourceType: "settings",
    resourceId: ctx.userId,
    after: {
      action: "deployDefaults.set",
      defaultDeployTarget: target,
      defaultServerId: serverId,
    },
  });

  return c.json({ defaultDeployTarget: target, defaultServerId: serverId });
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
export async function updateCloneCredentials(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json().catch(() => ({}));

  const rawToken = body?.token;
  const clearing = rawToken === null || rawToken === "";
  const setting = typeof rawToken === "string" && rawToken.length > 0;
  if (!clearing && !setting && rawToken !== undefined) {
    return c.json({ error: "token must be a string, null, or omitted" }, 400);
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
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
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

  return c.json(await getCloneCredentialsState(ctx.userId));
}

/**
 * PATCH /clone-strategy-preference - save the user's first-time-deploy choice.
 *
 * Body: { preference: "prompt" | "local" | "remote-with-token" }
 *
 * Once set to anything other than "prompt", the deploy nudge stops asking.
 */
export async function updateCloneStrategyPreference(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json().catch(() => ({}));
  const pref = body?.preference;
  if (!VALID_CLONE_STRATEGY_PREFERENCES.includes(pref)) {
    return c.json(
      {
        error: `preference must be one of: ${VALID_CLONE_STRATEGY_PREFERENCES.join(", ")}`,
      },
      400,
    );
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
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "settings.updated",
    resourceType: "settings",
    resourceId: ctx.userId,
    after: { action: "cloneStrategyPreference.set", cloneStrategyPreference: pref },
  });
  return c.json({ cloneStrategyPreference: pref });
}

/** PATCH /transfer - set the volume-transfer mode/compression preference. */
export async function updateTransferPrefs(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json().catch(() => ({}));
  const patch: { transferMode?: string; transferCompression?: string } = {};
  if (body?.transferMode !== undefined) {
    if (!isValidTransferMode(body.transferMode)) {
      return c.json({ error: "transferMode must be one of: auto, stream, direct, rsync" }, 400);
    }
    patch.transferMode = body.transferMode;
  }
  if (body?.transferCompression !== undefined) {
    if (!isValidTransferCompression(body.transferCompression)) {
      return c.json({ error: "transferCompression must be one of: auto, zstd, gzip, none" }, 400);
    }
    patch.transferCompression = body.transferCompression;
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "provide transferMode and/or transferCompression" }, 400);
  }

  const existing = await repos.settings.findByUser(ctx.userId);
  if (!existing) {
    await repos.settings.upsert({ id: generateId(), userId: ctx.userId, buildMode: "auto", ...patch });
  } else {
    await repos.settings.update(ctx.userId, patch);
  }
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "settings.updated",
    resourceType: "settings",
    resourceId: ctx.userId,
    after: { action: "transferPrefs.set", ...patch },
  });
  return c.json(await getTransferPrefs(ctx.userId));
}
