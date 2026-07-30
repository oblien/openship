/**
 * "Move this Openship instance to a remote server" — orchestration.
 *
 * Sequence:
 *   1. Preflight (SSH, dist, domain) — fail fast on anything broken.
 *   2. Ensure the Openship project row + reconcile config.
 *   3. (TODO when deploy-engine integration lands) Trigger the deploy
 *      via the standard project pipeline. The pipeline streams the
 *      release dist to the target server, installs, starts.
 *   4. Wait for the remote to report healthy.
 *   5. Dump local DB → scp to remote → restore on remote.
 *   6. Flip `instance_settings.teamMode` to `self_hosted_remote` and
 *      stamp `migrationTargetUrl`. Dashboard now renders the launcher.
 *   7. Audit log + done.
 *
 * The "actual deploy" in step 3 is intentionally wired to the existing
 * deployment-pipeline call shape but left as a TODO marker — exposing
 * the full pipeline trigger from this module requires importing the
 * deployments controller's startBuild path, which is its own surface
 * area. The wizard handles step 3 by calling
 * `POST /api/deployments/:id/build` after this service creates the
 * project and deployment row.
 *
 * Lock + audit + settings-upsert ceremony lives in `withMigration` —
 * this service only owns the path-specific SSH/dump/restore body.
 */

import { ensureOpenshipProject } from "./openship-project.service";
import { runPreflight, type DomainChoice } from "./preflight.service";
import { sealedRemoteImport } from "./db-migrate-remote.service";
import { probeTarget, TargetIsCloudError } from "./target-probe";
import { withMigration } from "./with-migration";
import type { Context } from "hono";

export interface MigrateInstanceInput {
  serverId: string;
  domain: DomainChoice;
  organizationId: string;
  /** Audit-context plumbing — kept on the orchestration layer so the
   *  audit row is attributed to the operator who initiated. */
  c: Context;
  userId: string;
}

export interface MigrateInstanceResult {
  projectId: string;
  groupId: string;
  migrationTargetUrl: string;
}

export class MigrationPreflightFailedError extends Error {
  readonly code = "MIGRATION_PREFLIGHT_FAILED" as const;
  constructor(public readonly checks: Record<string, { ok: boolean; detail: string }>) {
    super("Migration preflight failed.");
    this.name = "MigrationPreflightFailedError";
  }
}

/**
 * Build the public URL the operator's instance will live at, derived
 * from the domain choice. Used both for the migrationTargetUrl on the
 * local instance row AND for the route that Openship's deploy
 * pipeline configures on the target server.
 */
function publicUrlFor(domain: DomainChoice): string {
  if (domain.kind === "custom") {
    return `https://${domain.hostname}`;
  }
  return `https://${domain.slug}.opsh.io`;
}

export async function migrateInstanceToServer(
  input: MigrateInstanceInput,
): Promise<MigrateInstanceResult> {
  return withMigration<MigrateInstanceInput, MigrateInstanceResult>(
    {
      direction: "forward",
      variant: "self-hosted-remote",
      c: input.c,
      organizationId: input.organizationId,
      userId: input.userId,
      input,
    },
    async (ctx) => {
      // (Source is guaranteed non-cloud: exportInstance inside sealedRemoteImport
      // carries GATE 1 — refuses in CLOUD_MODE — and this route is unmounted on
      // the SaaS anyway, so no separate source guard is needed here.)

      // ── 1. Preflight ──────────────────────────────────────────────────────
      const preflight = await runPreflight({
        serverId: ctx.input.serverId,
        domain: ctx.input.domain,
      });
      if (!preflight.ready) {
        throw new MigrationPreflightFailedError(preflight.checks);
      }

      // ── 2. Project row + reconciled config ───────────────────────────────
      const { projectId, groupId, project } = await ensureOpenshipProject(
        ctx.input.organizationId,
      );

      const migrationTargetUrl = publicUrlFor(ctx.input.domain);

      // ── 3. Trigger the deploy. Owned by the deployments controller; the
      //       wizard calls POST /api/deployments/ to enqueue, then POST
      //       /api/deployments/:id/build to actually run. We RETURN the
      //       project handle from here so the wizard can drive that step
      //       and stream SSE progress directly to the operator. ──────────
      //
      //  (Intentional: this service stays a pure "set up the project
      //  +migrate data" primitive — the streaming-deploy lifecycle is
      //  the wizard's responsibility.)

      // ── 4. Remote-health-poll happens in the wizard between the deploy
      //       finishing and step 5 starting. We expose a probe endpoint
      //       (GET /api/system/migration/probe) that hits
      //       `${migrationTargetUrl}/api/health` and reports up/down.

      // GATE 3 (target): if the target's API is already reachable and reports
      // itself as a multi-tenant SaaS, refuse the destructive restore. Non-fatal
      // when unreachable — the SSH server row is definitionally a self-hosted box
      // and the target API often isn't up until the deploy (step 3) finishes.
      const targetProbe = await probeTarget(migrationTargetUrl);
      if (targetProbe.reachable && targetProbe.cloudMode) {
        throw new TargetIsCloudError(migrationTargetUrl);
      }

      // ── 5. Data migration — SEALED export → transfer → import on the target,
      //       which re-encrypts secrets under its own key (vs the old unsealed
      //       path that stripped them and made the operator re-link). ──────────
      await sealedRemoteImport({
        serverId: ctx.input.serverId,
        projectSlug: project.slug,
      });

      // ── 6. Hand the new settings patch + result back to `withMigration`.
      //       The helper performs the upsert and emits the success audit
      //       with the committed state — no manual upsert/audit here.
      //
      // migrationServerId is the bookkeeping switch-back needs to SSH back
      // into the right VPS. Without it the reverse flow couldn't find
      // where to pull from (no serverId on the deployment row).
      return {
        settings: {
          teamMode: "self_hosted_remote",
          migrationTargetUrl,
          migrationServerId: ctx.input.serverId,
          migratedAt: new Date(),
        },
        result: { projectId, groupId, migrationTargetUrl },
        auditAfter: { serverId: ctx.input.serverId },
      };
    },
  );
}
