/**
 * THE gate for `kind: 'local'` backup destinations — asked on every path that is
 * about to USE one, not just the paths that create one.
 *
 * Why it lives here rather than in the service: the policy used to be enforced
 * only where a destination row is WRITTEN (create / update / draft preflight),
 * while the three paths that CONSUME a row — a backup run, the retention prune,
 * and a restore — went straight to `toAdapterRow`. The adapter is deliberately
 * env-blind (see the docblock on `packages/adapters/src/backup/destinations/local.ts`,
 * which states the gate is "enforced at the apps/api layer"), so nothing between
 * a row and `fs.unlink`/`fs.rename` re-asked the question.
 *
 * That mattered because a row can arrive without passing the write path at all:
 * `backup_destination` is organization-scope dumpable, so an ingested row lands
 * complete, and `retention-prune-daily` runs on every instance. A local row plus
 * attacker-chosen artifact keys is then a filesystem write/delete on the control
 * plane.
 *
 * The rule this encodes: gate the CONSUMER, not the writer. A gate on the write
 * path only constrains rows that took it.
 *
 * Kept out of `local-path.ts` on purpose — that module's contract is "is this path
 * allowed", with the env gates explicitly excluded — and out of `destination.service.ts`
 * to avoid an import cycle with `hydrate-server.ts`.
 */

import { env } from "../../config";
import { assertLocalEndpointInRoot } from "./local-path";

/**
 * Throw unless a local destination may be used on this instance, and unless its
 * endpoint is inside the configured sandbox root.
 *
 * Both halves are checked every time. The endpoint is re-validated (not just the
 * policy flags) because a row that never went through the write path never had its
 * path checked either, and containment is what keeps a key from resolving outside
 * `BACKUP_LOCAL_ROOT`.
 */
export async function assertLocalDestinationAllowed(
  endpoint: string | null | undefined,
): Promise<void> {
  if (env.CLOUD_MODE) {
    throw new Error("Local destinations are disabled in cloud mode");
  }
  if (!env.BACKUP_ALLOW_LOCAL_DESTINATION) {
    throw new Error(
      "Local destinations are disabled. Set BACKUP_ALLOW_LOCAL_DESTINATION=true and BACKUP_LOCAL_ROOT to enable.",
    );
  }
  if (!endpoint) {
    // A local row with no endpoint would resolve against the process CWD in the
    // adapter. Refuse rather than guess.
    throw new Error("Local destination has no endpoint — refusing to resolve a backup path");
  }
  await assertLocalEndpointInRoot(endpoint, env.BACKUP_LOCAL_ROOT);
}
