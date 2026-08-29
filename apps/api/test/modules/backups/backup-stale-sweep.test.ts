/**
 * Selective stale-heartbeat sweep for in-flight backup runs (#516).
 *
 * NOTE: `makePgFake` hand-mirrors the WHERE in `sweepRunsWithStaleHeartbeat`
 * rather than running the real drizzle query, so it only guards intent — keep
 * the predicate below in sync with the repo when the sweep logic changes.
 */

import { describe, expect, it } from "vitest";
import { createBackupRunRepo } from "../../../../../packages/db/src/repos/backup.repo";

interface PgFake {
  db: unknown;
  rows: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
}

function makePgFake(rows: Array<Record<string, unknown>>): PgFake {
  const now = Date.now();
  const state: PgFake = { db: null, rows: rows.map((r) => ({ ...r })), updates: [] };
  state.db = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          state.updates.push(values);
          const idleCutoff = now - 10 * 60 * 1000;
          const ceilingCutoff = now - 6 * 60 * 60 * 1000;
          const swept: Array<Record<string, unknown>> = [];

          for (const row of state.rows) {
            const status = row.status as string;
            const last = (row.lastEventAt as Date).getTime();
            const terminal = ["succeeded", "failed", "cancelled", "server_error"];
            if (terminal.includes(status) || row.finishedAt) continue;

            // Mirror of sweepRunsWithStaleHeartbeat's WHERE. Two states are NOT
            // idle-swept. `uploading`, because a single-artifact dump holds
            // (uploading, bytes=NULL, lastEventAt=frozen) for the whole honest
            // upload. And `queued`, because lastEventAt does not move while a run
            // waits for a worker, so an idle window there measures queue depth —
            // both are bounded by the ceiling only.
            const stale =
              (["preparing", "snapshotting", "verifying"].includes(status) && last < idleCutoff) ||
              last < ceilingCutoff;

            if (stale) {
              Object.assign(row, values);
              swept.push(row);
            }
          }
          return {
            returning: async () => swept,
          };
        },
      }),
    }),
  };
  return state;
}

const CUTOFFS = (now: number) => ({
  idleCutoff: new Date(now - 10 * 60 * 1000),
  ceilingCutoff: new Date(now - 6 * 60 * 60 * 1000),
  reason: "stale",
});

describe("backupRun.sweepRunsWithStaleHeartbeat", () => {
  const now = Date.now();

  it("does NOT sweep a run that is merely waiting for a worker slot", async () => {
    // The regression this replaces. `lastEventAt` is stamped at row creation and
    // bumped only by transition(), so it does not move while a run sits queued —
    // an idle window there measures QUEUE DEPTH, not health. Run concurrency is 2,
    // so a project-level policy fanning out across a few services puts ordinary
    // runs well past 30 minutes while they are still perfectly claimable.
    //
    // And the write is TERMINAL: transition() then refuses every later write and
    // execute() bails on any row that is no longer `queued`, so sweeping it did not
    // merely warn early — it silently cancelled the backup forever. Queued rows are
    // never orphaned anyway (the in-process runner re-lists listQueued() every 30s;
    // BullMQ holds the job in Redis).
    const pg = makePgFake([
      {
        id: "bkr_q",
        status: "queued",
        lastEventAt: new Date(now - 45 * 60 * 1000),
        finishedAt: null,
      },
    ]);
    const repo = createBackupRunRepo(pg.db as never);
    const swept = await repo.sweepRunsWithStaleHeartbeat(CUTOFFS(now));
    expect(swept).toBe(0);
    expect(pg.rows[0].status).toBe("queued");
  });

  it("still sweeps a queued run past the 6h ceiling", async () => {
    // The genuine backstop survives: a row that has sat queued for six hours is a
    // real anomaly, not a busy queue.
    const pg = makePgFake([
      {
        id: "bkr_q_old",
        status: "queued",
        lastEventAt: new Date(now - 7 * 60 * 60 * 1000),
        finishedAt: null,
      },
    ]);
    const repo = createBackupRunRepo(pg.db as never);
    const swept = await repo.sweepRunsWithStaleHeartbeat(CUTOFFS(now));
    expect(swept).toBe(1);
    expect(pg.rows[0].status).toBe("server_error");
  });

  it("fails a preparing run idle past the idle cutoff", async () => {
    const pg = makePgFake([
      {
        id: "bkr_p",
        status: "preparing",
        lastEventAt: new Date(now - 11 * 60 * 1000),
        finishedAt: null,
      },
    ]);
    const repo = createBackupRunRepo(pg.db as never);
    const swept = await repo.sweepRunsWithStaleHeartbeat(CUTOFFS(now));
    expect(swept).toBe(1);
    expect(pg.rows[0].status).toBe("server_error");
  });

  it("does NOT idle-sweep an uploading run with null bytes (honest large dump, #516)", async () => {
    // A single-artifact pg_dump/mysqldump/mongodump streams the whole payload
    // through one destination.put; bytesTransferred stays NULL and lastEventAt
    // is frozen at the transition into `uploading` until the artifact finishes.
    // Idle-sweeping this would kill the exact backup #516 is about. A genuine
    // wedge is reaped in-process by the executor's per-stream idle watchdog.
    const pg = makePgFake([
      {
        id: "bkr_u",
        status: "uploading",
        bytesTransferred: null,
        lastEventAt: new Date(now - 25 * 60 * 1000), // well past idle, well under ceiling
        finishedAt: null,
      },
    ]);
    const repo = createBackupRunRepo(pg.db as never);
    const swept = await repo.sweepRunsWithStaleHeartbeat(CUTOFFS(now));
    expect(swept).toBe(0);
    expect(pg.rows[0].status).toBe("uploading");
  });

  it("does not fail uploading when bytes are moving and under the ceiling", async () => {
    const pg = makePgFake([
      {
        id: "bkr_ok",
        status: "uploading",
        bytesTransferred: 1_048_576,
        lastEventAt: new Date(now - 20 * 60 * 1000),
        finishedAt: null,
      },
    ]);
    const repo = createBackupRunRepo(pg.db as never);
    const swept = await repo.sweepRunsWithStaleHeartbeat(CUTOFFS(now));
    expect(swept).toBe(0);
    expect(pg.rows[0].status).toBe("uploading");
  });

  it("fails an uploading run once it passes the 6h ceiling", async () => {
    const pg = makePgFake([
      {
        id: "bkr_ceil",
        status: "uploading",
        bytesTransferred: null,
        lastEventAt: new Date(now - 7 * 60 * 60 * 1000),
        finishedAt: null,
      },
    ]);
    const repo = createBackupRunRepo(pg.db as never);
    const swept = await repo.sweepRunsWithStaleHeartbeat(CUTOFFS(now));
    expect(swept).toBe(1);
    expect(pg.rows[0].status).toBe("server_error");
  });
});
