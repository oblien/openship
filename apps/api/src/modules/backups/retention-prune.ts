/**
 * Retention prune — runs daily, applies each policy's retention rules.
 *
 * Source-agnostic: a project/service policy and a mail-server policy differ only
 * in which column scopes the run list and where the owning org is read from. Mail
 * used to be skipped outright, which meant the one source that backs up entire
 * maildirs was also the one with no ceiling.
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
import { policyOrganizationId } from "./backup.service";
import { safeErrorMessage } from "@repo/core";

export async function runRetentionSweep(): Promise<{
  policiesProcessed: number;
  policiesSkipped: number;
  runsDeleted: number;
  /** Runs whose objects the destination refused to delete — still on the books. */
  runsDeferred: number;
  errors: number;
}> {
  const stats = {
    policiesProcessed: 0,
    policiesSkipped: 0,
    runsDeleted: 0,
    runsDeferred: 0,
    errors: 0,
  };

  // Every enabled policy that HAS retention configured, cron or not. Walking
  // cron-scheduled policies missed the two triggers that produce runs
  // automatically without one — pre-deploy and webhook — so those grew without
  // a ceiling despite asking for one. A genuinely manual policy with no
  // retention set is excluded by the query, not by a guess about intent.
  for await (const policy of repos.backupPolicy.iterateEnabledForRetention()) {
    try {
      const result = await prunePolicy(policy);
      stats.runsDeleted += result.dropped;
      stats.runsDeferred += result.deferred;
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

/**
 * `skipped` is why a policy produced no pruning, or null when it was evaluated
 * normally. `deferred` counts runs left in place because their objects could not be
 * deleted — reported separately from `dropped` so "retention ran" and "the bytes are
 * gone" cannot be read as the same number.
 */
type PruneOutcome = { dropped: number; deferred: number; skipped: string | null };

const PRUNE_PAGE_SIZE = 500;

export async function prunePolicy(policy: BackupPolicy): Promise<PruneOutcome> {
  // Non-positive retention is not a tighter window, it's a loaded gun:
  // `retainCount: -1` puts every run outside the keep-set and deletes the lot.
  // Nothing validates the number on the way in, so it's normalized here, where
  // the deletes happen. Zero already behaved as unset; negatives now do too.
  const retainCount =
    policy.retainCount && policy.retainCount > 0 ? policy.retainCount : null;
  const retainDays = policy.retainDays && policy.retainDays > 0 ? policy.retainDays : null;
  // Both null now means "keep everything", asked for deliberately: omitting
  // retention yields `DEFAULT_RETAIN_COUNT` from the column default, and
  // migration 0096 backfilled the rows written before it. There is no fallback
  // here on purpose — one would override the explicit choice.
  if (!retainCount && !retainDays) {
    return { dropped: 0, deferred: 0, skipped: "retention set to unlimited" };
  }

  const destinationId = policy.destinationId;

  // Both backup sources page the same run table and delete through the same
  // destination adapter; they differ only in which column scopes the page and
  // where the owning org is read from. Mail used to bail out here — its runs
  // grew without a ceiling on a source whose whole point is message data, which
  // is the largest thing openship backs up.
  const scope = policy.projectId
    ? ({ projectId: policy.projectId } as const)
    : policy.mailServerId
      ? ({ mailServerId: policy.mailServerId } as const)
      : null;
  if (!scope) {
    return { dropped: 0, deferred: 0, skipped: "policy has neither a project nor a mail server" };
  }
  const organizationId = await policyOrganizationId(policy);
  if (!organizationId) {
    // The source row is gone, so the org that owns the runs is unknowable and
    // the paged read can't even be issued. Named, not silent — these artifacts
    // are now unprunable and someone has to go delete them by hand.
    return {
      dropped: 0,
      deferred: 0,
      skipped: policy.projectId ? "project soft-deleted" : "mail server row is gone",
    };
  }

  // Page through every run for this source. The 1000-run cap was a
  // silent data leak: projects past it never had older runs pruned and
  // accumulated forever. The page-then-filter pattern below has the
  // same memory footprint as the old code in practice (candidates are
  // a subset of total) but never silently truncates.
  // Candidates = THIS policy's succeeded, unlocked runs. Filtering by policyId
  // (not just source+destination) keeps two policies sharing a destination from
  // co-mingling their retention windows.
  const now = new Date();
  const candidates: BackupRun[] = [];
  for (let offset = 0; ; offset += PRUNE_PAGE_SIZE) {
    const page = await repos.backupRun.listByOrganization(organizationId, {
      ...scope,
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

  const cutoffDate = retainDays
    ? new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000)
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

  if (toDelete.length === 0) return { dropped: 0, deferred: 0, skipped: null };

  const destinationRow = await repos.backupDestination.findById(destinationId);
  if (!destinationRow) {
    // The artifacts outlive the destination row, so they are now unreachable
    // AND unprunable. Worth saying out loud rather than returning zero.
    return { dropped: 0, deferred: 0, skipped: `destination ${destinationId} is gone` };
  }
  const adapterRow = await toAdapterRow(destinationRow);
  const destination = resolveDestination(adapterRow);

  let dropped = 0;
  let deferred = 0;
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
        // `deleteMany` RESOLVES on a partial failure — it reports per-key outcomes
        // instead of throwing, and all three destinations count "already gone" as
        // deleted, so a non-empty `failed` means those objects are still there.
        //
        // Soft-deleting the row anyway was a one-way leak: the row is the only record
        // of which keys belong to this run, and every later sweep skips deleted rows,
        // so nothing would ever retry them. The operator sees the run disappear and
        // the quota not move, with no way to connect the two.
        //
        // Leaving the row alive costs one retained restore point until the next sweep;
        // dropping it costs the bytes forever.
        const { failed } = await destination.deleteMany(artifactKeys);
        if (failed.length > 0) {
          deferred += 1;
          console.warn(
            `[retention-prune] run ${run.id} kept: ${failed.length}/${artifactKeys.length} ` +
              `object(s) could not be deleted, will retry next sweep — ` +
              failed.map((f) => `${f.key}: ${f.error}`).join("; "),
          );
          continue;
        }
      }
      await repos.backupRun.softDelete(run.id);
      dropped += 1;
    } catch (err) {
      console.warn(
        `[retention-prune] failed to drop run ${run.id}: ${safeErrorMessage(err)}`,
      );
    }
  }
  return { dropped, deferred, skipped: null };
}

