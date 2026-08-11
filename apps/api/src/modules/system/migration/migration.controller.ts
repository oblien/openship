/**
 * HTTP surface for the team-mode migration flow.
 *
 *   POST /api/system/migration/preflight   — read-only readiness check
 *   POST /api/system/migration/start       — kick off the migration
 *   POST /api/system/migration/switch-back — reverse migration (PR 5)
 *
 * All endpoints require admin/owner role on the active org and refuse
 * to run when teamMode !== "single_user" (already migrated).
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { getRequestContext } from "../../../lib/request-context";
import { runPreflight, type DomainChoice } from "./preflight.service";
import {
  migrateInstanceToServer,
  MigrationPreflightFailedError,
} from "./migrate-instance.service";
import {
  migrateInstanceToCloud,
  MigrateToCloudNotConnectedError,
  MigrateToCloudTargetNotEmptyError,
  MigrateToCloudFailedError,
} from "./migrate-to-cloud.service";
import {
  switchBackToSingleUser,
  SwitchBackNotMigratedError,
  SwitchBackRemoteUnreachableError,
} from "./switch-back.service";
import {
  migrateInstanceToTunnel,
  TunnelSlugInvalidError,
  TunnelSlugTakenError,
  TunnelProvisionFailedError,
  TunnelMustBeCloudConnectedError,
} from "./migrate-to-tunnel.service";
import { OpenshipReleaseDistMissingError } from "./openship-dist";
import {
  MigrationAlreadyInProgressError,
  MigrationLockAcquireError,
} from "./migration-lock";

interface PreflightBody {
  serverId?: string;
  domain?: DomainChoice;
}

/**
 * POST /api/system/migration/preflight
 *
 * Body: { serverId, domain: { kind: "custom", hostname } | { kind: "free", slug } }
 * Returns: { ready, checks } — see PreflightResult.
 *
 * Read-only. Operator runs this from the wizard to paint a readiness
 * checklist before clicking Deploy.
 */
export async function preflight(c: Context) {
  const settings = await repos.instanceSettings.get();
  if ((settings?.teamMode ?? "single_user") !== "single_user") {
    return c.json(
      {
        error:
          "This instance is already in team mode. Switch back to single-user first to re-migrate.",
      },
      409,
    );
  }

  const body = (await c.req.json<PreflightBody>()) ?? {};
  if (!body.serverId || !body.domain) {
    return c.json(
      { error: "Body must include serverId and domain." },
      400,
    );
  }
  if (body.domain.kind !== "custom" && body.domain.kind !== "free") {
    return c.json(
      { error: "domain.kind must be 'custom' or 'free'." },
      400,
    );
  }

  const result = await runPreflight({
    serverId: body.serverId,
    domain: body.domain,
  });
  return c.json(result);
}

/**
 * POST /api/system/migration/start
 *
 * Body: { serverId, domain }
 *
 * Runs preflight, ensures the openship project row, dumps + restores
 * the DB to the remote, flips teamMode. Synchronous (not SSE) for v1;
 * the heavy lifting (deploy pipeline) is driven by the dashboard as a
 * follow-up step using the standard /api/deployments/:id/build SSE.
 */
export async function start(c: Context) {
  const ctx = getRequestContext(c);

  const settings = await repos.instanceSettings.get();
  if ((settings?.teamMode ?? "single_user") !== "single_user") {
    return c.json(
      {
        error:
          "This instance is already in team mode. Switch back to single-user first to re-migrate.",
      },
      409,
    );
  }

  const body = (await c.req.json<PreflightBody>()) ?? {};
  if (!body.serverId || !body.domain) {
    return c.json(
      { error: "Body must include serverId and domain." },
      400,
    );
  }

  try {
    const result = await migrateInstanceToServer({
      serverId: body.serverId,
      domain: body.domain,
      organizationId: ctx.organizationId,
      c,
      userId: ctx.userId,
    });
    return c.json({
      ok: true,
      projectId: result.projectId,
      groupId: result.groupId,
      migrationTargetUrl: result.migrationTargetUrl,
    });
  } catch (err) {
    if (err instanceof MigrationPreflightFailedError) {
      return c.json({ error: err.message, checks: err.checks }, 412);
    }
    if (err instanceof OpenshipReleaseDistMissingError) {
      return c.json({ error: err.message, code: err.code }, 412);
    }
    if (err instanceof MigrationAlreadyInProgressError) {
      return c.json({ error: err.message, code: err.code }, 409);
    }
    if (err instanceof MigrationLockAcquireError) {
      return c.json({ error: err.message, code: err.code }, 503);
    }
    const message = err instanceof Error ? err.message : "Migration failed.";
    console.error("[migration.start] failed:", err);
    return c.json({ error: message }, 500);
  }
}

/**
 * POST /api/system/migration/start-cloud
 *
 * Path B — migrate to Openship Cloud. Body: { allowNonEmptyTarget? }.
 *
 * Dumps the local DB, uploads it to api.openship.io/api/cloud/ingest-subgraph
 * (authenticated as the org owner via the stored cloud session token),
 * flips local teamMode to "cloud_hosted". Dashboard launcher then
 * points at app.openship.io.
 */
export async function startCloud(c: Context) {
  const ctx = getRequestContext(c);

  const settings = await repos.instanceSettings.get();
  if ((settings?.teamMode ?? "single_user") !== "single_user") {
    return c.json(
      {
        error:
          "This instance is already in team mode. Switch back to single-user first to re-migrate.",
      },
      409,
    );
  }

  const body = await c.req
    .json<{ allowNonEmptyTarget?: boolean }>()
    .catch(() => ({} as { allowNonEmptyTarget?: boolean }));

  try {
    const result = await migrateInstanceToCloud({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      c,
      allowNonEmptyTarget: body.allowNonEmptyTarget,
    });
    return c.json({
      ok: true,
      organizationId: result.organizationId,
      publicUrl: result.publicUrl,
      imported: result.imported,
    });
  } catch (err) {
    if (err instanceof MigrateToCloudNotConnectedError) {
      return c.json({ error: err.message, code: err.code }, 412);
    }
    if (err instanceof MigrateToCloudTargetNotEmptyError) {
      return c.json(
        { error: err.message, code: err.code, projectCount: err.projectCount },
        409,
      );
    }
    if (err instanceof MigrateToCloudFailedError) {
      return c.json({ error: err.message, code: err.code }, 502);
    }
    if (err instanceof MigrationAlreadyInProgressError) {
      return c.json({ error: err.message, code: err.code }, 409);
    }
    if (err instanceof MigrationLockAcquireError) {
      return c.json({ error: err.message, code: err.code }, 503);
    }
    const message = err instanceof Error ? err.message : "Cloud migration failed.";
    console.error("[migration.startCloud] failed:", err);
    return c.json({ error: message }, 500);
  }
}

/**
 * POST /api/system/migration/start-tunnel
 *
 * Path C — expose this instance via an Oblien edge tunnel. Body: { slug }.
 *
 * Provisions the tunnel record on Oblien, persists tunnelSlug + tunnelId
 * to instance_settings, flips teamMode → "tunneled", and starts the
 * long-lived TunnelClient so the public URL begins forwarding to the
 * local dashboard port. No data move, no SSH.
 */
export async function startTunnel(c: Context) {
  const ctx = getRequestContext(c);

  const settings = await repos.instanceSettings.get();
  if ((settings?.teamMode ?? "single_user") !== "single_user") {
    return c.json(
      {
        error:
          "This instance is already in team mode. Switch back to single-user first to re-migrate.",
      },
      409,
    );
  }

  const body = await c.req
    .json<{ slug?: string }>()
    .catch(() => ({} as { slug?: string }));
  if (!body.slug || typeof body.slug !== "string") {
    return c.json({ error: "Body must include a non-empty slug string." }, 400);
  }

  try {
    const result = await migrateInstanceToTunnel({
      slug: body.slug,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      c,
    });
    return c.json({
      ok: true,
      tunnelId: result.tunnelId,
      slug: result.slug,
      migrationTargetUrl: result.migrationTargetUrl,
    });
  } catch (err) {
    if (err instanceof TunnelSlugInvalidError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    if (err instanceof TunnelSlugTakenError) {
      return c.json({ error: err.message, code: err.code, slug: err.slug }, 409);
    }
    if (err instanceof TunnelMustBeCloudConnectedError) {
      return c.json({ error: err.message, code: err.code }, 412);
    }
    if (err instanceof TunnelProvisionFailedError) {
      return c.json({ error: err.message, code: err.code }, 502);
    }
    if (err instanceof MigrationAlreadyInProgressError) {
      return c.json({ error: err.message, code: err.code }, 409);
    }
    if (err instanceof MigrationLockAcquireError) {
      return c.json({ error: err.message, code: err.code }, 503);
    }
    const message = err instanceof Error ? err.message : "Tunnel migration failed.";
    console.error("[migration.startTunnel] failed:", err);
    return c.json({ error: message }, 500);
  }
}

/**
 * POST /api/system/migration/switch-back
 *
 * Reverse migration — team_* → single_user. Body: { abandonRemote? }.
 *
 * Pulls the latest data from the remote (operator's VPS for path A,
 * SaaS for path B), restores locally, flips teamMode. With
 * `abandonRemote=true`, skips the pull and just flips — operator
 * keeps whatever's currently in their local DB.
 *
 * TEAMMATES LOSE ACCESS. The remote keeps the data for a 30-day grace
 * period (background purge) so the operator can recover if they
 * change their mind.
 */
export async function switchBack(c: Context) {
  const ctx = getRequestContext(c);

  const body = await c.req
    .json<{ abandonRemote?: boolean }>()
    .catch(() => ({} as { abandonRemote?: boolean }));

  try {
    const result = await switchBackToSingleUser({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      c,
      abandonRemote: body.abandonRemote,
    });
    return c.json({
      ok: true,
      previousMode: result.previousMode,
      previousUrl: result.previousUrl,
      syncedFromRemote: result.syncedFromRemote,
      rowsRestored: result.rowsRestored,
      strippedEncryptedFields: result.strippedEncryptedFields,
    });
  } catch (err) {
    if (err instanceof SwitchBackNotMigratedError) {
      return c.json({ error: err.message, code: err.code }, 409);
    }
    if (err instanceof SwitchBackRemoteUnreachableError) {
      return c.json({ error: err.message, code: err.code }, 502);
    }
    if (err instanceof MigrationAlreadyInProgressError) {
      return c.json({ error: err.message, code: err.code }, 409);
    }
    if (err instanceof MigrationLockAcquireError) {
      return c.json({ error: err.message, code: err.code }, 503);
    }
    const message = err instanceof Error ? err.message : "Switch-back failed.";
    console.error("[migration.switchBack] failed:", err);
    return c.json({ error: message }, 500);
  }
}
