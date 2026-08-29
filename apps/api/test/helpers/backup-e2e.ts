/**
 * Driving the backup module through its OWN entry points, for the real-daemon suite.
 *
 * Every E2E that touches backups needs the same four moves — write a policy, run a
 * capture through the worker, prepare + apply a restore, poll for a terminal row — and
 * each of those has a detail that is easy to get subtly wrong and impossible to notice:
 *
 *   - ONE policy per (project, service). `uq_backup_policy_project_service` allows a
 *     single row, so a file that wants several payload kinds must RE-POINT its policy
 *     rather than accumulate one per kind — which is what an operator does anyway.
 *   - A capture is only proven by the bytes at the destination. "The run said succeeded"
 *     is exactly the claim [#611](https://github.com/oblien/openship/issues/611) taught
 *     us not to take on trust, so `capture()` stats every artifact and the manifest.
 *   - A restore is TWO calls and a poll: `beginPrepare` is synchronous-ish, `apply` is
 *     fire-and-forget, and the row is the only witness. A test that awaited `apply` and
 *     asserted immediately would pass on a restore that had not started.
 *   - Waiting for one status means failing loudly on any OTHER terminal status, with the
 *     row's own error message. Waiting on a timeout instead turns "the restore failed for
 *     this reason" into "stuck", which is the least useful failure a suite can produce.
 *
 * It lived, in full, inside `backup-payload-matrix.e2e.test.ts`, and the second file to
 * need it (`backup-db-roundtrip`) would have copied it. Two copies of "insist the bytes
 * are really there" is how one of them ends up not insisting.
 *
 * The context is read through a THUNK, because these ids are assigned in `beforeAll` and
 * the harness is built while the `describe` body runs.
 */

import { randomBytes } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { repos, type BackupRestore, type BackupRestoreStatus } from "@repo/db";
import type { RequestContext } from "../../src/lib/request-context";
import { backupOrchestrator } from "../../src/modules/backups/backup.orchestrator";
import { restoreOrchestrator } from "../../src/modules/backups/restore.orchestrator";
import { seedBackupRun } from "./seed";

export interface CapturedArtifact {
  key: string;
  name?: string | null;
  sha256: string | null;
  sizeBytes: number;
  payloadKind: string;
  metadata: Record<string, unknown>;
}

/** Everything a capture or a restore needs, resolved at call time. */
export interface BackupE2EContext {
  ctx: RequestContext;
  organizationId: string;
  projectId: string;
  serviceId: string;
  /** The one policy, re-pointed per case. */
  policyId: string;
  destinationId: string;
  /** Filesystem root of the `local` destination, for the "are the bytes there" checks. */
  destRoot: string;
}

const TERMINAL: ReadonlySet<BackupRestoreStatus> = new Set<BackupRestoreStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "server_error",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function backupE2EHarness(read: () => BackupE2EContext) {
  /**
   * Poll until the row reaches `want`, and FAIL on any other terminal status carrying
   * that row's own error message — a wrong-but-terminal outcome is a real answer and
   * should read as one, not as a timeout.
   */
  const waitForRestore = async (
    restoreId: string,
    want: BackupRestoreStatus,
  ): Promise<BackupRestore> => {
    const deadline = Date.now() + 300_000;
    for (;;) {
      const row = await repos.backupRestore.findById(restoreId);
      if (row?.status === want) return row;
      if (row && TERMINAL.has(row.status)) {
        throw new Error(
          `restore ${restoreId} reached ${row.status} instead of ${want}: ` +
            `${row.errorMessage ?? "(no error recorded)"}`,
        );
      }
      if (Date.now() > deadline) throw new Error(`restore ${restoreId} stuck`);
      await sleep(200);
    }
  };

  /**
   * Capture through the product's own worker entry point, WITHOUT asserting the outcome —
   * the refusal cases need the failed row.
   */
  const attemptCapture = async (payloadKind: string, payloadConfig: Record<string, unknown>) => {
    const { organizationId, projectId, serviceId, policyId, destinationId } = read();
    await repos.backupPolicy.update(policyId, {
      payloadKind: payloadKind as never,
      payloadConfig: payloadConfig as never,
    });
    const run = await seedBackupRun(organizationId, {
      policyId,
      destinationId,
      projectId,
      serviceId,
      sourceKind: "service",
      status: "queued",
      triggeredBy: "manual",
    });
    await backupOrchestrator.execute(run.id);
    const row = await repos.backupRun.findById(run.id);
    if (!row) throw new Error(`run ${run.id} vanished`);
    return row;
  };

  /** The same, plus the assertion #611 exists to force: the bytes are really there. */
  const capture = async (
    payloadKind: string,
    payloadConfig: Record<string, unknown>,
  ): Promise<{ runId: string; artifacts: CapturedArtifact[] }> => {
    const { destRoot } = read();
    const row = await attemptCapture(payloadKind, payloadConfig);
    expect(row.status, row.errorMessage ?? "").toBe("succeeded");
    const artifacts = (row.artifacts ?? []) as CapturedArtifact[];
    expect(row.manifestKey).toBeTruthy();
    expect((await stat(join(destRoot, row.manifestKey!))).size).toBeGreaterThan(0);
    for (const a of artifacts) {
      expect(a.sha256, `sha256 for ${a.key}`).toMatch(/^[0-9a-f]{64}$/);
      expect((await stat(join(destRoot, a.key))).size, `size of ${a.key}`).toBe(a.sizeBytes);
    }
    return { runId: row.id, artifacts };
  };

  /**
   * Prepare + apply, and hand back the restore id — the caller decides which terminal
   * status is the expected one. Prepare's integrity verdict is asserted here either way:
   * every one of these runs writes a sha256, so anything else means the digest plumbing
   * broke and every later assertion would be testing the wrong thing.
   */
  const beginRestore = async (runId: string): Promise<string> => {
    const { ctx } = read();
    const token = randomBytes(24).toString("base64url");
    const { restoreId } = await restoreOrchestrator.beginPrepare({
      runId,
      trigger: { source: "manual", userId: ctx.userId },
      confirmationToken: token,
    });
    const prepared = await waitForRestore(restoreId, "prepared");
    expect((prepared.meta as Record<string, unknown>).integrity).toBe("sha256");
    await restoreOrchestrator.apply(ctx, restoreId, token);
    return restoreId;
  };

  /** Prepare + apply + insist it succeeded. */
  const restore = async (runId: string): Promise<BackupRestore> => {
    const restoreId = await beginRestore(runId);
    return waitForRestore(restoreId, "succeeded");
  };

  /** Every object at the destination, recursively — orphan detection for a failed run. */
  const destObjects = async (dir = read().destRoot): Promise<number> => {
    let n = 0;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      n += entry.isDirectory() ? await destObjects(join(dir, entry.name)) : 1;
    }
    return n;
  };

  return { waitForRestore, attemptCapture, capture, beginRestore, restore, destObjects };
}
