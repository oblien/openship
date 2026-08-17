/**
 * Reverse migration: team_* → single_user.
 *
 * Pulls the remote's data back into this local instance, restores it,
 * flips teamMode. Bidirectional with the forward migration — closes
 * the data-direction loop.
 *
 * Path A (`self_hosted_remote`): SSH back to the operator's VPS using
 *   `migrationServerId` stashed at forward-migration time. Generate a
 *   fresh dump on the remote via `db:dump`, SCP it back, restore.
 *
 * Path B (`cloud_hosted`): call `cloudClient.exportSubgraph(orgScope)`
 *   against the SaaS — it returns the dump scoped to the operator's
 *   org. Restore locally.
 *
 * Path C (`tunneled`): no data move on the forward path, so switch-back
 *   is a teardown of the Oblien tunnel + bookkeeping flip. abandonRemote
 *   is irrelevant here.
 *
 * `abandonRemote: true` skips the sync on Paths A/B — operator flips
 *   teamMode and keeps whatever's currently in their local DB. Useful
 *   when the remote is dead, unreachable, or the operator doesn't want
 *   to overwrite local changes made post-migration.
 *
 * Hard contract regardless of path:
 *   - Calling against `teamMode === "single_user"` is a no-op + 409.
 *   - Remote data is left intact (operator can re-migrate, manually
 *     export, or wait for the 30-day grace-period purge).
 *   - The audit log captures the operator's intent so a future
 *     purge job knows which migration record to act on.
 *
 * Encrypted columns are stripped on the dump side (both VPS and
 * cloud paths) — operator re-links cloud/clone-tokens/etc. on the
 * local host. The wizard surfaces the stripped fields list from the
 * dump's `strippedEncryptedFields` array.
 *
 * Lock acquisition, atomic previousMode read, the single
 * instance_settings upsert, and the success/failure audit events are
 * all owned by `withMigration` — this body only does the per-path
 * data movement and returns the settings patch + result.
 */

import {
  restoreSubgraph,
  type DatabaseDump,
} from "@repo/db";

import { sshManager } from "../../../lib/ssh-manager";
import { env } from "../../../config/env";
import { stopTunnelAgent, teardownTunnel } from "../../tunneling";
import { withMigration, type MigrationVariant } from "./with-migration";
import type { Context } from "hono";

export interface SwitchBackInput {
  organizationId: string;
  userId: string;
  c: Context;
  /**
   * Skip the data sync — flip teamMode without pulling from the remote.
   * Useful when the remote is dead or when the operator wants to keep
   * whatever's in the local DB right now.
   */
  abandonRemote?: boolean;
}

export interface SwitchBackResult {
  previousMode: "self_hosted_remote" | "cloud_hosted" | "tunneled";
  previousUrl: string;
  /** True when we actually pulled + restored data from the remote. */
  syncedFromRemote: boolean;
  /** Total rows restored (0 when abandonRemote=true). */
  rowsRestored: number;
  /**
   * From the dump's strippedEncryptedFields — the wizard surfaces this
   * to the operator so they know which connections to re-link
   * (cloud account, clone tokens, env vars, backup creds, etc.).
   */
  strippedEncryptedFields: Array<{ table: string; column: string; rowsAffected: number }>;
}

export class SwitchBackNotMigratedError extends Error {
  readonly code = "SWITCH_BACK_NOT_MIGRATED" as const;
  constructor() {
    super("Instance is already in single-user mode.");
    this.name = "SwitchBackNotMigratedError";
  }
}

export class SwitchBackRemoteUnreachableError extends Error {
  readonly code = "SWITCH_BACK_REMOTE_UNREACHABLE" as const;
  constructor(reason: string) {
    super(
      `Could not pull data from the remote: ${reason}. Retry, or pass abandonRemote=true to switch back without syncing.`,
    );
    this.name = "SwitchBackRemoteUnreachableError";
  }
}

/**
 * Path A: SSH into the operator's VPS, run db:dump on the deployed
 * openship instance, read the file back, return as a parsed dump.
 *
 * `migrationServerId` was stamped on instance_settings during the
 * forward migration — that's our pointer to the right VPS.
 */
async function pullDumpFromVps(serverId: string): Promise<DatabaseDump> {
  const stamp = Date.now();
  const remoteDumpPath = `/tmp/openship-switchback-${stamp}.json`;
  let payload: string | null = null;

  try {
    // The deployed openship instance lives under
    // /var/lib/openship/projects/openship-instance-<orgId>/current —
    // same convention startWebmailDeploy uses. The org id is part
    // of the slug; we wildcard it because there's one openship-instance
    // dir per VPS (single org per local install).
    const remoteProjectDir = `/var/lib/openship/projects/openship-instance-*/current`;
    // stripEncrypted defaults to false; switch-back wants the data
    // to come back clean (cloud session token decrypts on the local
    // host's secret), so we DO request stripped here — the operator
    // re-links rather than carrying potentially-stale crypto.
    const dumpCmd = `cd ${remoteProjectDir} && bun --cwd packages/db scripts/dump.ts --out ${remoteDumpPath} --strip-encrypted`;
    // Journaled: a large DB dump can exceed exec()'s 30s default, and a
    // mid-dump SSH drop shouldn't force a full re-dump — re-attach and
    // harvest instead. (Read-only on the remote, so a re-run is harmless too.)
    await sshManager.execJournaled(
      serverId,
      `migrate:switchback-dump:${serverId}:${stamp}`,
      dumpCmd,
      { timeoutMs: 30 * 60_000 },
    );
    await sshManager.withExecutor(serverId, async (exec) => {
      await exec.exec(`chmod 600 ${remoteDumpPath}`);
      payload = await exec.readFile(remoteDumpPath);
      await exec.exec(`rm -f ${remoteDumpPath}`);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SwitchBackRemoteUnreachableError(message);
  }

  if (!payload) {
    throw new SwitchBackRemoteUnreachableError("dump payload was empty");
  }
  try {
    return JSON.parse(payload) as DatabaseDump;
  } catch (err) {
    throw new SwitchBackRemoteUnreachableError(
      `dump was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Path B: ask the SaaS for a dump of the team org's data via the
 * mirror endpoint we just added on cloud-saas.
 */
async function pullDumpFromCloud(_organizationId: string): Promise<DatabaseDump> {
  throw new SwitchBackRemoteUnreachableError(
    "Cloud-hosted switch-back is not available on Operator.",
  );
}

/**
 * Map the previously-active teamMode to the MigrationVariant that
 * tags the audit payload. Mirrors the forward-direction labels so the
 * purge job can match a switch-back to its originating migration on
 * variant alone.
 */
function variantFor(
  previousMode: "self_hosted_remote" | "cloud_hosted" | "tunneled",
): MigrationVariant {
  switch (previousMode) {
    case "self_hosted_remote":
      return "self-hosted-remote";
    case "cloud_hosted":
      return "cloud-hosted";
    case "tunneled":
      return "tunneled";
  }
}

export async function switchBackToSingleUser(
  input: SwitchBackInput,
): Promise<SwitchBackResult> {
  // ── 1. We need previousMode to pick a variant before invoking
  //       withMigration, but withMigration is the authoritative reader
  //       of previousMode (inside the lock). Resolve the variant from
  //       ctx.previousMode and let the helper own the read. The
  //       no-op/409 guard also happens inside the body so the lock is
  //       released cleanly on the rejection path.
  //
  //       We pass "self-hosted-remote" as the invocation variant
  //       initially; the actual recorded variant on success/failure
  //       comes from the body's branching (see auditAfter override and
  //       the per-mode patch below). The invocation variant is only
  //       used for the "started" breadcrumb, which is fine to be
  //       approximate — the success/failure rows are what the purge
  //       job consumes.
  return withMigration<SwitchBackInput, SwitchBackResult>(
    {
      direction: "reverse",
      // Will be refined per-mode in the body's auditAfter.
      variant: "self-hosted-remote",
      c: input.c,
      organizationId: input.organizationId,
      userId: input.userId,
      input,
    },
    async (ctx) => {
      // ── 2. Reject the no-op case before doing any work. withMigration
      //       still emits a failure audit row, which is the right
      //       signal: "operator hit switch-back from the wrong state."
      if (ctx.previousMode === "single_user") {
        throw new SwitchBackNotMigratedError();
      }
      const previousMode = ctx.previousMode as
        | "self_hosted_remote"
        | "cloud_hosted"
        | "tunneled";
      const previousUrl = ctx.previousSettings?.migrationTargetUrl ?? "";
      const variant = variantFor(previousMode);

      // ── 3a. Tunneled mode (Path C) — no data move on the forward path,
      //        so switch-back is a teardown of the tunnel + bookkeeping
      //        flip. Stop the local agent first so in-flight WS frames
      //        don't get caught on the provider-side delete, then call
      //        the generic teardown to drop the public URL. The
      //        bookkeeping clear is handled by the settings patch in
      //        the finale. abandonRemote is irrelevant here. The
      //        provider name is hard-coded to "oblien" today because
      //        team-mode only supports Oblien; when other providers
      //        land we'll persist the provider name with the tunnel
      //        record.
      if (previousMode === "tunneled") {
        stopTunnelAgent();
        const tunnelIdStr = ctx.previousSettings?.tunnelId;
        if (tunnelIdStr && env.CLOUD_MODE) {
          try {
            await teardownTunnel({ provider: "oblien", externalId: tunnelIdStr });
          } catch (err) {
            // Don't fail the switch-back if the provider is unreachable —
            // the record will become orphaned but the operator's local
            // instance is back to single-user mode, which is the contract.
            console.warn(
              "[switch-back] tunnel teardown failed:",
              err instanceof Error ? err.message : err,
            );
          }
        }

        return {
          settings: {
            teamMode: "single_user",
            migrationTargetUrl: null,
            migrationServerId: null,
            migratedAt: null,
            tunnelSlug: null,
            tunnelId: null,
          },
          result: {
            previousMode,
            previousUrl,
            syncedFromRemote: false,
            rowsRestored: 0,
            strippedEncryptedFields: [],
          },
          auditBefore: { migrationTargetUrl: previousUrl },
          auditAfter: {
            variant,
            syncedFromRemote: false,
            rowsRestored: 0,
            strippedEncryptedFields: [],
          },
        };
      }

      // ── 3b. Pull data back from the remote (or skip if abandoning).
      //        Paths A + B share the restore step; only the dump source
      //        differs. Typed errors (SwitchBackRemoteUnreachableError)
      //        propagate up through withMigration's failure audit and
      //        the controller's error-mapping intact.
      let rowsRestored = 0;
      let strippedEncryptedFields: SwitchBackResult["strippedEncryptedFields"] = [];

      if (!input.abandonRemote) {
        let dump: DatabaseDump;
        if (previousMode === "self_hosted_remote") {
          const serverId = ctx.previousSettings?.migrationServerId;
          if (!serverId) {
            throw new SwitchBackRemoteUnreachableError(
              "migrationServerId is not set — this instance was migrated before serverId tracking was added. Use abandonRemote=true to switch back without syncing, or restore via `bun db:restore` manually.",
            );
          }
          dump = await pullDumpFromVps(serverId);
        } else {
          dump = await pullDumpFromCloud(input.organizationId);
        }

        // Restore — wipe + insert under one transaction with FK checks
        // deferred (see packages/db/src/dump.ts).
        //
        // The cloud path returns an organization-scope dump, but switch-back
        // wants a clean local instance re-seeded. wipe mode requires
        // instance scope, so we promote the scope here. This is a known
        // wart; a future restoreSubgraph option `wipeScope: SubgraphScope`
        // would let us truncate an arbitrary scope without inferring it from
        // the dump.
        const wipeDump: DatabaseDump = { ...dump, scope: { kind: "instance" } };
        await restoreSubgraph(wipeDump, { mode: "wipe" });

        rowsRestored = Object.values(dump.tables).reduce(
          (n, rows) => n + rows.length,
          0,
        );
        strippedEncryptedFields = dump.strippedEncryptedFields ?? [];
      }

      // ── 4. Finale. The settings patch clears every migration-related
      //       column so a future re-migration starts from a clean slate.
      //       Note that tunnelSlug/tunnelId are also cleared here even
      //       on Paths A + B — they're always null in those modes, so
      //       the explicit null is idempotent and protects the invariant
      //       that "single_user means migration bookkeeping is empty"
      //       in case a previous switch-back left stale data behind.
      return {
        settings: {
          teamMode: "single_user",
          migrationTargetUrl: null,
          migrationServerId: null,
          migratedAt: null,
          tunnelSlug: null,
          tunnelId: null,
        },
        result: {
          previousMode,
          previousUrl,
          syncedFromRemote: !input.abandonRemote,
          rowsRestored,
          strippedEncryptedFields,
        },
        auditBefore: { migrationTargetUrl: previousUrl },
        auditAfter: {
          variant,
          syncedFromRemote: !input.abandonRemote,
          rowsRestored,
          strippedEncryptedFields: strippedEncryptedFields.map(
            (f) => `${f.table}.${f.column}`,
          ),
        },
      };
    },
  );
}
