/**
 * Dump the local DB → transfer to remote → restore.
 *
 * Atomic on the remote (single transaction inside restoreDatabase),
 * but the LOCAL→REMOTE leg is necessarily non-atomic — we generate a
 * dump file, scp it over, then trigger the restore. If the wizard
 * fails mid-stream the operator can re-run; the dump is idempotent
 * and the restore is wipe-then-insert so a partial first run is
 * cleaned up by the second.
 *
 * Why we don't pipe stdin over SSH directly: the dump can be tens of
 * MB, and Drizzle's restore wants the whole envelope in memory at
 * once (it inserts table-by-table). Writing to disk on the remote
 * keeps the API process's memory pressure bounded.
 */

import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dumpSubgraph } from "@repo/db";
import { sshManager } from "../../../lib/ssh-manager";
import { exportInstance } from "../data-transfer/export.service";

export interface DumpRemoteRestoreInput {
  /** The target server's id — we already have an SSH executor for it. */
  serverId: string;
  /**
   * The Openship project slug deployed on the remote. We use this to
   * locate the per-deploy working dir on the target so the restore
   * runs from the right cwd (where node_modules and the bun bin are).
   */
  projectSlug: string;
}

/**
 * End-to-end migrate: dump → scp → restore. Throws on any failure;
 * the local tempfile is always cleaned up.
 */
export async function dumpRemoteRestore(
  input: DumpRemoteRestoreInput,
): Promise<void> {
  // ── 1. Dump the local DB to a temp file.
  //
  // stripEncrypted: every blob encrypted with this host's
  // BETTER_AUTH_SECRET (cloud session token, clone tokens, env var
  // values, backup credentials, notification channel configs) gets
  // nulled out. The remote can't decrypt them with a different key, so
  // carrying them across is worse than leaving them blank — the operator
  // re-links cleanly on the new host. The dump's
  // `strippedEncryptedFields` array surfaces what was stripped so the
  // wizard can tell the operator exactly what to reconnect. ─────────
  const dump = await dumpSubgraph({ kind: "instance" }, { stripEncrypted: true });
  const payload = JSON.stringify(dump);

  const localTmpDir = mkdtempSync(join(tmpdir(), "openship-migrate-"));
  const localTmpPath = join(localTmpDir, "dump.json");
  writeFileSync(localTmpPath, payload, { encoding: "utf-8", mode: 0o600 });

  const migrateStamp = Date.now();
  const remoteDumpPath = `/tmp/openship-migrate-${migrateStamp}.json`;

  try {
    // ── 2. Push the dump file over SSH. ──────────────────────────────
    //
    // Idempotent (overwrite + chmod), so at-least-once withExecutor is fine.
    // For multi-MB payloads writeFile is adequate; tens-of-MB+ would want a
    // streaming approach.
    await sshManager.withExecutor(input.serverId, async (exec) => {
      await exec.writeFile(remoteDumpPath, payload);
      // Tight perms — dump contains hashed creds, audit log, etc.
      await exec.exec(`chmod 600 ${remoteDumpPath}`);
    });

    // ── 3. Restore on the remote — EXACTLY-ONCE. ─────────────────────
    //
    // Destructive (wipe-then-insert) and long-running, so it must not
    // double-apply on a reconnect. `execJournaled` runs it detached on the
    // remote and journals the outcome by opId: an SSH drop mid-restore
    // re-attaches and harvests instead of re-running, and a genuine
    // interruption throws OpInterruptedError (the operator re-runs cleanly —
    // the restore is wipe-then-insert). The opId is unique per dump so a
    // fresh migrate is a fresh restore, not a harvest of the old one.
    // (This also removes exec()'s 30s default timeout, which would truncate a
    // real restore.)
    //
    // Path: /var/lib/openship/projects/<slug>/current — the deploy pipeline's
    // per-project layout. execJournaled throws on non-zero exit like exec().
    const remoteProjectDir = `/var/lib/openship/projects/${input.projectSlug}/current`;
    await sshManager.execJournaled(
      input.serverId,
      `migrate:restore:${input.serverId}:${migrateStamp}`,
      `cd ${remoteProjectDir} && bun --cwd packages/db scripts/restore.ts --in ${remoteDumpPath}`,
      { timeoutMs: 30 * 60_000 },
    );

    // ── 4. Best-effort cleanup of the dump file on the remote. ──────
    // Not critical — /tmp is wiped on reboot — but keeping the file
    // around indefinitely leaks data at rest.
    await sshManager
      .withExecutor(input.serverId, (exec) => exec.exec(`rm -f ${remoteDumpPath}`))
      .catch(() => {});
  } finally {
    // ── 5. Local cleanup, regardless of outcome. ─────────────────────
    try {
      unlinkSync(localTmpPath);
      rmSync(localTmpDir, { recursive: true, force: true });
    } catch {
      // best-effort — /tmp gets cleared on reboot
    }
  }
}

/**
 * SEALED migrate: export (passphrase-sealed, secrets INCLUDED) → transfer to
 * remote → import on the target, which re-encrypts every secret under the
 * TARGET's key. The successor to `dumpRemoteRestore` — that one `stripEncrypted`s
 * secrets (operator re-links); this carries them across, re-keyed, so env vars /
 * SSH creds / tokens survive the move.
 *
 * The passphrase is EPHEMERAL (random per run) — it only protects the file while
 * it sits on the target's /tmp. It's handed to the target import via a 0600
 * env-file that's sourced then deleted, NEVER on argv (keeps it out of the
 * process table / journald — repo has prior unquoted-arg RCE history).
 *
 * exportInstance carries GATE 1 (refuses in CLOUD_MODE), so a multi-tenant SaaS
 * can't be the source — no separate source guard needed here.
 *
 * NOTE: the SSH transfer + remote exec are only verifiable end-to-end against a
 * real target box; the sealing/import halves are unit-covered on their own.
 */
export async function sealedRemoteImport(input: DumpRemoteRestoreInput): Promise<void> {
  // Ephemeral transport passphrase — url-safe, high-entropy, never persisted.
  const passphrase = randomBytes(24).toString("base64url");
  const file = await exportInstance({ passphrase });
  const payload = JSON.stringify(file);

  const localTmpDir = mkdtempSync(join(tmpdir(), "openship-sealed-"));
  const localTmpPath = join(localTmpDir, "export.osx");
  writeFileSync(localTmpPath, payload, { encoding: "utf-8", mode: 0o600 });

  const stamp = Date.now();
  const remoteFilePath = `/tmp/openship-sealed-${stamp}.osx`;
  const remoteEnvPath = `/tmp/openship-sealed-${stamp}.env`;
  const remoteProjectDir = `/var/lib/openship/projects/${input.projectSlug}/current`;

  try {
    // Push the sealed file + a 0600 env-file carrying the passphrase (out of argv).
    await sshManager.withExecutor(input.serverId, async (exec) => {
      await exec.writeFile(remoteFilePath, payload);
      await exec.exec(`chmod 600 ${remoteFilePath}`);
      await exec.writeFile(remoteEnvPath, `OPENSHIP_IMPORT_PASSPHRASE=${passphrase}\n`);
      await exec.exec(`chmod 600 ${remoteEnvPath}`);
    });

    // Import on the remote — EXACTLY-ONCE (destructive wipe-restore). Source the
    // passphrase env-file, run the target-side importInstance script (which
    // re-keys secrets under the target's key), then always delete the env-file.
    await sshManager.execJournaled(
      input.serverId,
      `migrate:sealed-import:${input.serverId}:${stamp}`,
      `cd ${remoteProjectDir} && set -a && . ${remoteEnvPath} && set +a && ` +
        `bun --cwd apps/api scripts/import-instance.ts --in ${remoteFilePath} --mode wipe; ` +
        `rc=$?; rm -f ${remoteEnvPath}; exit $rc`,
      { timeoutMs: 30 * 60_000 },
    );

    // Best-effort cleanup of the sealed file on the remote (env-file already gone).
    await sshManager
      .withExecutor(input.serverId, (exec) => exec.exec(`rm -f ${remoteFilePath}`))
      .catch(() => {});
  } finally {
    try {
      unlinkSync(localTmpPath);
      rmSync(localTmpDir, { recursive: true, force: true });
    } catch {
      // best-effort — /tmp gets cleared on reboot
    }
  }
}
