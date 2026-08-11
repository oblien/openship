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
 * Idempotent by construction: the work list is "artifacts that are still broken",
 * so a repaired run stops matching.
 */

import { repos, type BackupPolicy } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { registerStartupHook } from "../../lib/startup";

/** How many unrecoverable run ids to name before summarizing the rest. */
const LOG_ID_CAP = 20;

interface ArtifactEntry {
  payloadKind?: string;
  metadata?: Record<string, unknown> | null;
}

function readCommand(config: unknown, key: "produceCommand" | "restoreCommand"): string | null {
  const value = (config as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** Does this entry still need repair? Mirrors the repo's SQL predicate. */
function needsRestoreCommand(entry: ArtifactEntry): boolean {
  if (entry?.payloadKind !== "custom_command") return false;
  const recorded = entry.metadata?.restoreCommand;
  return !(typeof recorded === "string" && recorded.trim());
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
    const policy = run.policyId ? await loadPolicy(run.policyId) : undefined;
    const restoreCommand = readCommand(policy?.payloadConfig, "restoreCommand");
    if (!restoreCommand) {
      unrecoverable.push(run.id);
      continue;
    }
    // Recorded alongside for provenance — a hand-restore reads both halves.
    const produceCommand = readCommand(policy?.payloadConfig, "produceCommand");

    const entries = (run.artifacts ?? []) as ArtifactEntry[];
    const patched = entries.map((entry) =>
      needsRestoreCommand(entry)
        ? {
            ...entry,
            metadata: {
              ...(entry.metadata ?? {}),
              restoreCommand,
              ...(produceCommand && !entry.metadata?.produceCommand ? { produceCommand } : {}),
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
          `[backups] ${unrecoverable.length} backup run(s) hold a custom_command artifact with no ` +
            `restoreCommand and no surviving policy to recover it from — these CANNOT be restored. ` +
            `Re-run the backup to capture a restorable artifact. Runs: ${named}${rest}`,
        );
      }
    },
  });
}
