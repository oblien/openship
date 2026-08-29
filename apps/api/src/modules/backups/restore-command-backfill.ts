/**
 * D5 backfill — re-attach `restoreCommand` to already-captured artifacts.
 *
 * The orchestrator used to hand-pick three keys out of `policy.payloadConfig`
 * and dropped `produceCommand` / `restoreCommand` / `artifactName` — the exact
 * three every mail-server backup policy writes. Forwarding the config fixes NEW
 * runs; it does nothing for the ones already sitting in a destination, because
 * the metadata was frozen into `backup_run.artifacts` at capture time and
 * `CustomCommandProducer.restore` reads the command from there.
 *
 * The command is recoverable because it still lives on the owning policy, and
 * it's the same shell it was then — the archive's contents didn't change, only
 * our record of how to unpack them. A run whose policy is gone (SET NULL on
 * delete, so history outlives the schedule) is NOT recoverable: we log those by
 * id every boot rather than silently, because otherwise the operator discovers
 * it at the one moment it matters.
 *
 * A SECOND way the command went missing lands here too: the recorded metadata used
 * to be run through the build-log credential scrubber, so a command carrying a DSN
 * (`mongorestore --uri "mongodb://root:pw@host"`) was stored as `mongodb://***@host`
 * — present, plausible, and certain to fail authentication. That is worse than the
 * empty case, because nothing flagged it: the audit only looked for an EMPTY command.
 * New runs no longer take that path; these are the ones already captured, and the
 * policy is again the place the real command survives.
 *
 * Idempotent by construction: the work list is "artifacts that are still broken",
 * so a repaired run stops matching. The SQL side of that list is deliberately broader
 * than the check here (it matches any `***`), so every run is re-tested against the
 * narrow shape before anything is written or reported — a command that legitimately
 * contains `***` is skipped rather than rewritten or announced as unrestorable.
 */

import { repos, type BackupPolicy } from "@repo/db";
import { isRedactedCommand } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import { registerStartupHook } from "../../lib/startup";

/** How many unrecoverable run ids to name before summarizing the rest. */
const LOG_ID_CAP = 20;

interface ArtifactEntry {
  payloadKind?: string;
  metadata?: Record<string, unknown> | null;
}

function readCommand(config: unknown, key: "produceCommand" | "restoreCommand"): string | null {
  return usableCommand((config as Record<string, unknown> | null | undefined)?.[key]);
}

/** A usable recorded command, or null if there is nothing to restore from. */
function usableCommand(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  // A scrubbed command is worse than a missing one: it runs and fails on auth.
  return isRedactedCommand(value) ? null : value;
}

/**
 * Does this entry still need repair? The AUTHORITATIVE predicate — the repo's SQL is a
 * broader candidate filter (it matches any `***`), and this narrows it to the shape the
 * scrubber actually manufactures so an operator's own `***` is never overwritten.
 */
function needsRestoreCommand(entry: ArtifactEntry): boolean {
  if (entry?.payloadKind !== "custom_command") return false;
  return usableCommand(entry.metadata?.restoreCommand) === null;
}

export async function backfillCustomCommandRestoreCommands(): Promise<{
  repaired: number;
  unrecoverable: string[];
}> {
  const runs = await repos.backupRun.listCustomCommandMissingRestoreCommand();
  if (runs.length === 0) return { repaired: 0, unrecoverable: [] };

  // One policy backs many runs; a mail server's whole history is usually a
  // single policy.
  const policies = new Map<string, BackupPolicy | undefined>();
  const loadPolicy = async (id: string) => {
    if (!policies.has(id)) {
      policies.set(id, await repos.backupPolicy.findById(id).catch(() => undefined));
    }
    return policies.get(id);
  };

  let repaired = 0;
  const unrecoverable: string[] = [];

  for (const run of runs) {
    const entries = (run.artifacts ?? []) as ArtifactEntry[];
    // Re-check against the narrow predicate before reporting anything. The repo's SQL
    // matches any `***`, so a run reaching here may be perfectly restorable — naming
    // it "CANNOT be restored" at boot would be a false alarm about the one subsystem
    // an operator has to be able to trust.
    if (!entries.some(needsRestoreCommand)) continue;

    const policy = run.policyId ? await loadPolicy(run.policyId) : undefined;
    const restoreCommand = readCommand(policy?.payloadConfig, "restoreCommand");
    if (!restoreCommand) {
      unrecoverable.push(run.id);
      continue;
    }
    // Recorded alongside for provenance — a hand-restore reads both halves.
    const produceCommand = readCommand(policy?.payloadConfig, "produceCommand");

    const patched = entries.map((entry) =>
      needsRestoreCommand(entry)
        ? {
            ...entry,
            metadata: {
              ...(entry.metadata ?? {}),
              restoreCommand,
              // Overwrite a scrubbed produceCommand too — it is the provenance half a
              // hand-restore reads, and `***` there is just as misleading.
              ...(produceCommand && !usableCommand(entry.metadata?.produceCommand)
                ? { produceCommand }
                : {}),
              restoreCommandBackfilledFrom: run.policyId,
            },
          }
        : entry,
    );

    try {
      await repos.backupRun.setArtifacts(run.id, patched);
      repaired++;
    } catch (err) {
      console.warn(
        `[backups] restoreCommand backfill failed for run ${run.id}: ${safeErrorMessage(err)}`,
      );
    }
  }

  return { repaired, unrecoverable };
}

export function registerCustomCommandRestoreBackfill(): void {
  registerStartupHook({
    id: "backups:restore-command-backfill",
    modes: ["selfhosted", "desktop"],
    run: async () => {
      const { repaired, unrecoverable } = await backfillCustomCommandRestoreCommands();
      if (repaired > 0) {
        console.log(
          `[backups] repaired ${repaired} custom_command backup run(s) that had no restoreCommand recorded`,
        );
      }
      if (unrecoverable.length > 0) {
        const named = unrecoverable.slice(0, LOG_ID_CAP).join(", ");
        const rest =
          unrecoverable.length > LOG_ID_CAP ? ` (+${unrecoverable.length - LOG_ID_CAP} more)` : "";
        console.warn(
          `[backups] ${unrecoverable.length} backup run(s) hold a custom_command artifact whose ` +
            `restoreCommand is missing or credential-scrubbed, with no surviving policy to recover ` +
            `it from — these CANNOT be restored. Re-run the backup to capture a restorable ` +
            `artifact. Runs: ${named}${rest}`,
        );
      }
    },
  });
}
