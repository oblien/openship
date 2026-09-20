import type { ProjectControlSchemas } from "@repo/contracts";
import type { ResourceServices } from "../../../resource-operations";
import type { ProjectDependencies } from "../../../projects";

import { repos } from "@repo/db";
import { normalizeProjectDeleteOptions } from "@repo/contracts";
import { failOperation } from "../../lib/operation-errors";
import * as projectTeardown from "./project-teardown";
import { assertResourceInOrg } from "../../lib/resource-access";
import { instanceAuthorization } from "../../lib/instance-authorization";
import { clearProjectBuildCache } from "../deployments/build-cache-gc";

export function createProjectLifecycleOperations(
  recordAudit: ProjectDependencies["recordAudit"],
): Pick<ResourceServices<typeof ProjectControlSchemas>, "remove" | "clearBuildCache"> {
  return {
    async remove(ctx, id, input) {
      const { organizationId } = ctx;
      const { force, forceOrphan, wipeVolumes, recordOnly } = normalizeProjectDeleteOptions(
        input ?? {},
      );
      // Verify project exists in this org BEFORE the gate so we don't
      // leak "active work" details for a project that isn't ours.
      const proj = await repos.project.findById(id);
      if (!proj || proj.organizationId !== organizationId) {
        // No audit on 404 — a stale URL isn't a deletion attempt worth
        // surfacing in the audit feed. Security teams only want failed
        // attempts on resources the actor could actually see.
        return failOperation({ ok: false, error: "Project not found" }, 404);
      }
      // The Openship control plane deploys itself; deleting its app row would drop
      // the Apps entry + domain while the host service keeps running (and orphan the
      // edge route). It's managed from the CLI, never torn down via the dashboard.
      if (proj.appTemplateId === "openship") {
        return failOperation(
          {
            ok: false,
            code: "PROJECT_IS_CONTROL_PLANE",
            error:
              "This is the Openship control plane — manage it with the CLI, not the dashboard.",
          },
          403,
        );
      }
      // ── Run the atomic teardown. ──────────────────────────────────────
      const result = await projectTeardown.teardownProject(ctx, id, {
        force,
        forceOrphan,
        wipeVolumes,
        recordOnly,
      });
      // Typed pre-step rejections short-circuit before we record a
      // `project.deleted` row. Each gets its own audit event + HTTP code.
      if (result.rejection === "active_work") {
        const active = result.active!;
        const activePayload = {
          hasActiveDeployment: active.hasActiveDeployment,
          hasActiveBackup: active.hasActiveBackup,
          hasActiveBackupRestore: active.hasActiveBackupRestore,
          hasActiveMigration: active.hasActiveMigration,
          deploymentIds: active.activeDeploymentIds,
          backupRunIds: active.activeBackupRunIds,
          backupRestoreIds: active.activeBackupRestoreIds,
          migrationIds: active.activeMigrationIds,
        };
        recordAudit(ctx, {
          eventType: "project.deletion.rejected",
          resourceType: "project",
          resourceId: id,
          after: {
            code: "PROJECT_HAS_ACTIVE_WORK",
            force,
            forceOrphan,
            wipeVolumes,
            active: activePayload,
          },
        });
        return failOperation(
          {
            ok: false,
            code: "PROJECT_HAS_ACTIVE_WORK",
            error: active.summary,
            active: activePayload,
          },
          409,
        );
      }
      if (result.rejection === "claim_lock_held") {
        recordAudit(ctx, {
          eventType: "project.deletion.rejected",
          resourceType: "project",
          resourceId: id,
          after: { code: "PROJECT_DELETION_IN_PROGRESS", force, forceOrphan, wipeVolumes },
        });
        return failOperation(
          {
            ok: false,
            code: "PROJECT_DELETION_IN_PROGRESS",
            error: "Deletion already in progress for this project",
          },
          409,
        );
      }
      if (result.rejection === "already_deleted") {
        // Idempotent: row's already gone, treat as success so the dashboard
        // navigates the user away. No audit row for a "deletion of a thing
        // that wasn't there" — matches the controller's 404 behavior.
        return { ok: true, message: "already deleted", steps: result.steps };
      }
      if (result.rejection === "org_mismatch") {
        // Belt-and-suspenders against a future caller skipping the
        // controller's org check. We DO emit a rejection event because the
        // actor was authenticated and the org check was bypassed somehow —
        // a real security signal.
        recordAudit(ctx, {
          eventType: "project.deletion.rejected",
          resourceType: "project",
          resourceId: id,
          after: { code: "PROJECT_ORG_MISMATCH", force, forceOrphan, wipeVolumes },
        });
        return failOperation(
          { ok: false, code: "PROJECT_ORG_MISMATCH", error: "Project not found" },
          404,
        );
      }
      recordAudit(ctx, {
        eventType: result.rowDeleted ? "project.deleted" : "project.deletion.failed",
        resourceType: "project",
        resourceId: id,
        after: {
          force,
          forceOrphan,
          wipeVolumes,
          recordOnly,
          ok: result.ok,
          rowDeleted: result.rowDeleted,
          steps: result.steps,
          // Projects this app was unlinked from on the way out.
          unlinkedProjectIds: [...new Set(result.unlinked.map((u) => u.projectId))],
        },
      });
      // The row is gone but a non-empty `unrecoverable` means ops needs to
      // clean up stragglers (a leaked container, a webmail dir we couldn't
      // wipe). 207 surfaces this so the dashboard can warn the user.
      if (result.rowDeleted && result.unrecoverable.length > 0) {
        return {
          ok: false,
          message: "Project deleted, but some external cleanup failed",
          steps: result.steps,
          unrecoverable: result.unrecoverable,
          unlinked: result.unlinked,
        };
      }
      // Row still around — teardown couldn't complete. This is now ONLY the
      // "reachable server but destroy kept failing" case (unreachable resources are
      // orphaned and the row drops). 409 so the caller can retry, and
      // `canForceOrphan` tells the dashboard it may offer a force-orphan delete
      // that records the leaked resources for GC and drops the row anyway.
      if (!result.rowDeleted) {
        return failOperation(
          {
            ok: false,
            code: "PROJECT_TEARDOWN_FAILED",
            // The teardown service knows whether the manifest was collected and the
            // reachable destroy itself failed; other failures cannot be bypassed.
            canForceOrphan: result.canForceOrphan,
            message: result.unrecoverable[0]?.error ?? "Teardown failed",
            steps: result.steps,
            unrecoverable: result.unrecoverable,
            unlinked: result.unlinked,
          },
          409,
        );
      }
      return {
        ok: true,
        message: "deleted",
        steps: result.steps,
        // Resources that couldn't be reached at delete time — recorded for GC to
        // reclaim once the server is back. Drives the "will be cleaned up when the
        // server is reachable" toast. Empty on a fully-clean delete.
        orphaned: result.orphaned,
        // Projects this app was linked into: they keep running, minus the injected
        // env var, so their live container holds a dead value until the next deploy.
        unlinked: result.unlinked,
      };
    },
    async clearBuildCache(ctx, id) {
      const { userId, organizationId } = ctx;
      // BuildKit cache is daemon-wide and may include other organizations' builds;
      // an org/project role is therefore not a sufficient authorization boundary.
      await instanceAuthorization.assert(ctx);
      const project = await repos.project.findById(id);
      assertResourceInOrg(project, "Project", organizationId, id);
      const result = await clearProjectBuildCache(project);
      recordAudit(ctx, {
        eventType: "project.build_cache.cleared",
        resourceType: "project",
        resourceId: id,
        after: {
          hostScoped: true,
          target: result.target,
          serverId: result.serverId,
          cachesDeleted: result.cachesDeleted.length,
          bytesReclaimed: result.spaceReclaimed,
        },
      });
      return {
        success: true,
        hostScoped: true,
        target: result.target,
        serverId: result.serverId,
        cachesDeleted: result.cachesDeleted.length,
        bytesReclaimed: result.spaceReclaimed,
      };
    },
  };
}
