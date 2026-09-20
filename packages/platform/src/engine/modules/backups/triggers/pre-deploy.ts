/**
 * Pre-deploy trigger — enqueues one backup run per enabled
 * `trigger_on_pre_deploy` policy of the project that is about to be deployed.
 *
 * Wired into `deployments/build-pipeline.ts`, inside `executeBuildAndDeploy`
 * and before the build begins. That is the ONE funnel every deploy reaches —
 * `requestBuildAccess` (first deploy / wizard / API / CLI), `redeployBuildSession`
 * (redeploy, app update), `triggerDeployment` (webhook auto-deploy, rollback
 * rebuild) and `startBuild` all get there through `kickoffBuild` — and it is
 * outside the mode branch, so single-app, static-edge and compose deploys are
 * all covered. It used to be called from `redeployBuildSession` behind an opt-in
 * only the app-update path passed, which is why an ordinary deploy — the button,
 * a webhook push, a CLI deploy — ran with no backup at all: the one safety net an
 * operator switches on precisely because something is about to change.
 *
 * There is exactly one call site on purpose. A second one anywhere in the deploy
 * path does not make the net stronger, it enqueues a duplicate run per policy for
 * the same cutover — which is what the removed opt-in did once this became
 * universal.
 *
 * WHY BEFORE THE BUILD, not immediately before the cutover: the old container
 * keeps running for the whole build, so a snapshot taken here is still the
 * pre-deploy state — and since we do not block on the run (below), starting it
 * minutes before `runtime.destroy(previous.containerId)` is what gives it the
 * headroom to actually finish first. Firing at the cutover would have been more
 * precise about WHEN and worse at the thing the toggle promises.
 *
 * Call-site contract: `await` this before the destructive deploy step. The await
 * covers the ENQUEUE only — the durable `backup_run` INSERT plus the job-runner
 * hand-off — never the runs themselves. A slow or failing backup must not block
 * or fail a deploy, so the run may still be in flight when the cutover happens.
 *
 * Semantics:
 *   - Best-effort. Failures are LOGGED but do NOT block the deploy, including a
 *     failure to even read the policies.
 *   - Per-policy queueing: a project with 5 services each having pre-deploy
 *     backups fires 5 jobs. They run in parallel up to the worker's concurrency
 *     cap, alongside the new deploy.
 *   - The orchestrator records `trigger: 'pre_deploy'` so the dashboard can group
 *     these in the run list.
 *   - Redeploys and rollback rebuilds DO fire it. An earlier draft excluded them
 *     because "the rollback orchestrator preserves the previous artifact
 *     natively" — true of the image and the workspace, and irrelevant to the
 *     volumes and the database, which are the only things this trigger captures.
 */

import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { backupOrchestrator } from "../backup.orchestrator";

export async function firePreDeployBackups(opts: {
  projectId: string;
  organizationId: string;
}): Promise<{ enqueued: number; failed: number }> {
  let enqueued = 0;
  let failed = 0;

  try {
    const policies = await repos.backupPolicy.listEnabledPreDeployByProject(opts.projectId);
    // The pre-deploy backup runs are attributed to the policy creator,
    // not a specific user (the deploy may have been triggered by anyone
    // with project:write). The orchestrator pulls policy.createdBy when
    // trigger.userId is unset.
    for (const policy of policies) {
      try {
        await backupOrchestrator.enqueue({
          policyId: policy.id,
          trigger: {
            source: "pre_deploy",
            userId: policy.createdBy ?? "system",
          },
        });
        enqueued += 1;
      } catch (err) {
        failed += 1;
        console.warn(
          `[pre-deploy-backup] policy ${policy.id} enqueue failed: ${safeErrorMessage(err)}`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[pre-deploy-backup] failed to load policies for project ${opts.projectId}: ${safeErrorMessage(err)}`,
    );
  }

  return { enqueued, failed };
}
