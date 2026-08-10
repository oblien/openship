/**
 * Retention prune — runs daily, applies each policy's retention rules.
 *
 * Two retention dimensions, evaluated independently per policy:
 *   - `retainCount` — keep at most N most-recent succeeded runs.
 *   - `retainDays`  — drop succeeded runs older than N days.
 *
 * Both null = keep everything. That is now a deliberate choice rather than the
 * accident it used to be: policies created over the API stored two nulls, this
 * function short-circuited, and retention never ran for them at all. The count
 * has a column default (`DEFAULT_RETAIN_COUNT`) and 0096 backfilled the rows
 * that predate it, so reaching this file with both null means somebody asked.
 *
 * For runs outside the keep-set, delete their artifacts from the
 * destination and soft-delete the backup_run row. Honors
 * `retentionLockedUntil` ("Protect this backup", Chunk 3 UI).
 *
 * Used to be a BullMQ worker; now it's a function registered with the
 * JobRunner via scheduleRecurring. Works identically on BullMQ + in-
 * process backends.
 */

import { repos, type BackupPolicy, type BackupRun } from "@repo/db";
import { resolveDestination } from "@repo/adapters";
import { toAdapterRow } from "../backup-destinations/hydrate-server";
import { safeErrorMessage } from "@repo/core";

export async function runRetentionSweep(): Promise<{
  policiesProcessed: number;
  policiesSkipped: number;
  runsDeleted: number;
  errors: number;
}> {
  const stats = { policiesProcessed: 0, policiesSkipped: 0, runsDeleted: 0, errors: 0 };

  // Every enabled policy that HAS retention configured, cron or not. Walking
  // cron-scheduled policies missed the two triggers that produce runs
  // automatically without one — pre-deploy and webhook — so those grew without
  // a ceiling despite asking for one. A genuinely manual policy with no
  // retention set is excluded by the query, not by a guess about intent.
  for await (const policy of repos.backupPolicy.iterateEnabledForRetention()) {
    try {
      const result = await prunePolicy(policy);
      stats.runsDeleted += result.dropped;
      if (result.skipped) {
        // Every skip is logged. Silence here is what let "retention is on" and
        // "retention runs" diverge for a whole release.
        stats.policiesSkipped += 1;
        console.warn(`[retention-prune] policy ${policy.id} skipped: ${result.skipped}`);
      } else {
        stats.policiesProcessed += 1;
      }
    } catch (err) {
      stats.errors += 1;
      console.warn(
        `[retention-prune] policy ${policy.id} failed: ${safeErrorMessage(err)}`,
      );
    }
  }
  return stats;
}

/** Why a policy produced no pruning, or null when it was evaluated normally. */
type PruneOutcome = { dropped: number; skipped: string | null };

const PRUNE_PAGE_SIZE = 500;

export async function prunePolicy(policy: BackupPolicy): Promise<PruneOutcome> {
  const retainCount = policy.retainCount;
  // Both null now means "keep everything", asked for deliberately: omitting
  // retention yields `DEFAULT_RETAIN_COUNT` from the column default, and
  // migration 0096 backfilled the rows written before it. There is no fallback
  // here on purpose — one would override the explicit choice.
  if (!retainCount && !policy.retainDays) {
    return { dropped: 0, skipped: "retention set to unlimited" };
  }

  // Mail-server policies aren't project-scoped; their runs list by project,
  // so retention pruning for them is a follow-up. Skip cleanly for now.
  if (!policy.projectId) {
    return { dropped: 0, skipped: "mail-server policy — retention not implemented" };
  }

  const destinationId = policy.destinationId;
  const project = await repos.project.findById(policy.projectId);
  if (!project) {
    return { dropped: 0, skipped: "project soft-deleted" };
  }

  // Page through every run for this project. The 1000-run cap was a
  // silent data leak: projects past it never had older runs pruned and
  // accumulated forever. The page-then-filter pattern below has the
  // same memory footprint as the old code in practice (candidates are
  // a subset of total) but never silently truncates.
  // Candidates = THIS policy's succeeded, unlocked runs. Filtering by policyId
  // (not just project+destination) keeps two policies sharing a destination from
  // co-mingling their retention windows.
  const now = new Date();
  const candidates: BackupRun[] = [];
  for (let offset = 0; ; offset += PRUNE_PAGE_SIZE) {
    const page = await repos.backupRun.listByOrganization(project.organizationId, {
      projectId: policy.projectId,
      limit: PRUNE_PAGE_SIZE,
      offset,
    });
    if (page.length === 0) break;
    for (const r of page) {
      if (r.policyId !== policy.id) continue;
      if (r.destinationId !== destinationId) continue;
      if (r.status !== "succeeded") continue;
      if (r.deletedAt) continue;
      if (r.retentionLockedUntil && r.retentionLockedUntil > now) continue;
      candidates.push(r);
    }
    if (page.length < PRUNE_PAGE_SIZE) break;
  }

  const cutoffDate = policy.retainDays
    ? new Date(Date.now() - policy.retainDays * 24 * 60 * 60 * 1000)
    : null;

  // Apply retention PER SERVICE. A project-default policy fans out to N services
  // (N runs per tick), so retainCount must keep N runs per service — not N runs
  // total (which would evict every service but one). Per-service policies have a
  // single group, so their behavior is unchanged.
  const groups = new Map<string, BackupRun[]>();
  for (const run of candidates) {
    const key = run.serviceId ?? run.mailServerId ?? "__project__";
    const arr = groups.get(key);
    if (arr) arr.push(run);
    else groups.set(key, [run]);
  }

  const toDelete: BackupRun[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const aT = a.finishedAt?.getTime() ?? 0;
      const bT = b.finishedAt?.getTime() ?? 0;
      return bT - aT;
    });
    let kept = 0;
    for (const run of group) {
      let drop = false;
      if (retainCount && kept >= retainCount) drop = true;
      if (cutoffDate && run.finishedAt && run.finishedAt < cutoffDate) drop = true;
      if (drop) toDelete.push(run);
      else kept += 1;
    }
  }

  if (toDelete.length === 0) return { dropped: 0, skipped: null };

  const destinationRow = await repos.backupDestination.findById(destinationId);
  if (!destinationRow) {
    // The artifacts outlive the destination row, so they are now unreachable
    // AND unprunable. Worth saying out loud rather than returning zero.
    return { dropped: 0, skipped: `destination ${destinationId} is gone` };
  }
  const adapterRow = await toAdapterRow(destinationRow);
  const destination = resolveDestination(adapterRow);

  let dropped = 0;
  for (const run of toDelete) {
    try {
      const artifactKeys = Array.isArray(run.artifacts)
        ? run.artifacts
            .map((a) =>
              typeof a === "object" && a && "key" in a
                ? (a as { key: string }).key
                : null,
            )
            .filter((k): k is string => typeof k === "string")
        : [];
      if (run.manifestKey) artifactKeys.push(run.manifestKey);

      if (artifactKeys.length > 0) {
        await destination.deleteMany(artifactKeys);
      }
      await repos.backupRun.softDelete(run.id);
      dropped += 1;
    } catch (err) {
      console.warn(
        `[retention-prune] failed to drop run ${run.id}: ${safeErrorMessage(err)}`,
      );
    }
  }
  return { dropped, skipped: null };
}

