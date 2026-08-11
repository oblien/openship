/**
 * A job run's terminal state must never depend on the text it captured.
 *
 * Field failure: a custom job's remote command printed a NUL byte. That byte
 * went verbatim into `job_run.output` (text), Postgres refused the UPDATE, and
 * the throw happened BEFORE the terminal `complete` SSE event, before the
 * notification, and before the dependency fan-out — `startCommandRun`'s
 * `.catch()` only console.error'd. The row stayed "running" forever, the live
 * log stream never closed, and every job depending on this one never fired.
 *
 * The DB fake below refuses what Postgres refuses so the failure path is real.
 */

import "./_env";
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  jobRows: {} as Record<string, unknown>,
  /** Every finish() call the repo ACCEPTED. */
  stored: [] as Array<Record<string, unknown>>,
  /** Every finish() call attempted, accepted or not. */
  attempted: [] as Array<Record<string, unknown>>,
  execImpl: null as null | (() => Promise<{ code: number; output: string }>),
  dependencyStarts: [] as string[],
  /** When true the fake DB refuses every write (dead database). */
  dbDown: false,
}));

vi.mock("@repo/db", () => ({
  repos: {
    job: {
      findByKey: async (k: string) => h.jobRows[k] ?? null,
      listAll: async () => Object.values(h.jobRows),
      update: async () => {},
    },
    jobRun: {
      start: async (d: Record<string, unknown>) => {
        // A dependency fan-out opens its own run row — record who fired.
        if (d.trigger === "dependency") h.dependencyStarts.push(String(d.jobId));
        return { id: `jrun_${h.attempted.length + 1}`, ...d };
      },
      finish: async (id: string, data: Record<string, unknown>) => {
        h.attempted.push({ id, ...data });
        if (h.dbDown) throw new Error("connection terminated unexpectedly");
        for (const value of Object.values(data)) {
          if (typeof value === "string" && value.includes("\u0000")) {
            throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
          }
        }
        h.stored.push({ id, ...data });
      },
      listRecent: async () => [{ status: "success" }],
    },
    member: { listByUser: async () => [] },
    notificationChannel: { findById: async () => null },
    notificationDelivery: { create: async () => {} },
    notificationSubscription: { listEnabledForDispatch: async () => [] },
  },
}));

vi.mock("../../../src/lib/ssh-manager", () => ({
  sshManager: {
    retain: () => {},
    release: () => {},
    withExecutor: async (_id: string, fn: (ex: unknown) => Promise<unknown>) =>
      fn({ streamExec: () => h.execImpl!() }),
  },
}));

import { runCommandJobTick } from "../../../src/modules/jobs/job-command";
import { jobRunBus, type JobRunEvent } from "../../../src/modules/jobs/job-run.sse";

const cmdJob = (key: string, cfg: Record<string, unknown>) => ({
  key,
  actionType: "command",
  actionConfig: cfg,
  dependsOn: null,
  notifyConfig: null,
  createdBy: null,
  enabled: true,
});

beforeEach(() => {
  h.jobRows = {};
  h.stored.length = 0;
  h.attempted.length = 0;
  h.dependencyStarts.length = 0;
  h.execImpl = null;
  h.dbDown = false;
});

describe("custom job run — output must not strand the row", () => {
  it("reaches a terminal row + closes the SSE stream when the output has a NUL", async () => {
    h.jobRows["custom:nul"] = cmdJob("custom:nul", { serverId: "srv1", command: "dump" });
    h.execImpl = async () => ({ code: 0, output: "row 1\u0000row 2\n" });
    const seen: JobRunEvent[] = [];
    const unsub = jobRunBus.subscribe("jrun_1", (e) => seen.push(e));

    await runCommandJobTick("custom:nul");
    unsub();

    expect(h.stored).toHaveLength(1);
    expect(h.stored[0].status).toBe("success");
    // The output is KEPT (scrubbed), not shed: sanitizing happens before the
    // write, so the first attempt is already storable.
    expect(String(h.stored[0].output)).toBe("row 1row 2\n");
    expect(h.attempted).toHaveLength(1);
    // Terminal SSE event still published → the client's stream closes.
    expect(seen.filter((e) => e.type === "complete")).toHaveLength(1);
  });

  it("fires dependents after a success whose output needed scrubbing", async () => {
    h.jobRows["custom:src"] = cmdJob("custom:src", { serverId: "srv1", command: "dump" });
    h.jobRows["custom:dep"] = {
      ...cmdJob("custom:dep", { serverId: "srv1", command: "after" }),
      dependsOn: ["custom:src"],
    };
    h.execImpl = async () => ({ code: 0, output: "done\u0000" });

    await runCommandJobTick("custom:src");

    expect(h.dependencyStarts).toEqual(["custom:dep"]);
  });

  it("still reaches a terminal row when the stored text is refused outright", async () => {
    // The scrubber is bypassed by making the fake refuse the sanitized payload
    // too (a column-length overflow behaves the same way): the outcome must be
    // retried with less payload rather than left "running".
    h.jobRows["custom:hostile"] = cmdJob("custom:hostile", { serverId: "srv1", command: "x" });
    h.execImpl = async () => ({ code: 1, output: "boom" });
    let calls = 0;
    const original = h.jobRows["custom:hostile"];
    void original;
    const seen: JobRunEvent[] = [];
    const unsub = jobRunBus.subscribe("jrun_1", (e) => seen.push(e));

    // Refuse the first write only — the ladder's second rung must land.
    const { repos } = (await import("@repo/db")) as unknown as {
      repos: { jobRun: { finish: (id: string, d: Record<string, unknown>) => Promise<void> } };
    };
    const realFinish = repos.jobRun.finish;
    repos.jobRun.finish = async (id, data) => {
      if (++calls === 1) {
        h.attempted.push({ id, ...data });
        throw new Error("value too long for type character varying");
      }
      return realFinish(id, data);
    };
    try {
      await runCommandJobTick("custom:hostile");
    } finally {
      repos.jobRun.finish = realFinish;
      unsub();
    }

    expect(calls).toBe(2);
    expect(h.stored).toHaveLength(1);
    expect(h.stored[0].status).toBe("failed");
    // The status + reason survive; only the captured output is sacrificed.
    expect(String(h.stored[0].output)).toContain("omitted");
    expect(String(h.stored[0].error)).toContain("code 1");
    expect(seen.filter((e) => e.type === "complete")).toHaveLength(1);
  });

  it("closes the SSE stream even when the row cannot be written at all", async () => {
    h.jobRows["custom:dbdown"] = cmdJob("custom:dbdown", { serverId: "srv1", command: "x" });
    h.execImpl = async () => ({ code: 0, output: "ok" });
    h.dbDown = true;
    const seen: JobRunEvent[] = [];
    const unsub = jobRunBus.subscribe("jrun_1", (e) => seen.push(e));

    await runCommandJobTick("custom:dbdown");
    unsub();

    expect(h.stored).toHaveLength(0);
    // Every rung of the ladder was tried, and the stream still terminated.
    expect(h.attempted.length).toBeGreaterThanOrEqual(3);
    expect(seen.filter((e) => e.type === "complete")).toHaveLength(1);
  });
});

describe("custom job run — stored output is storable by construction", () => {
  it("leaves no lone surrogate however the cap falls", async () => {
    // 300k astral chars: the 200k cap lands mid-pair, and the per-line cap
    // inside the sanitizer lands mid-pair too.
    h.jobRows["custom:astral"] = cmdJob("custom:astral", { serverId: "srv1", command: "x" });
    h.execImpl = async () => ({ code: 0, output: "🚀".repeat(150_000) });

    await runCommandJobTick("custom:astral");

    const stored = String(h.stored[0].output);
    expect(stored.isWellFormed()).toBe(true);
    expect(stored.length).toBeLessThanOrEqual(200_000);
  });

  it("drops every NUL, not just the first", async () => {
    h.jobRows["custom:many"] = cmdJob("custom:many", { serverId: "srv1", command: "x" });
    h.execImpl = async () => ({ code: 0, output: "a\u0000b\u0000c\nd\u0000\n" });

    await runCommandJobTick("custom:many");

    expect(String(h.stored[0].output)).toBe("abc\nd\n");
  });

  it("scrubs the error column too (it is remote text as well)", async () => {
    h.jobRows["custom:err"] = cmdJob("custom:err", { serverId: "srv1", command: "x" });
    h.execImpl = async () => {
      throw new Error("ssh: handshake\u0000failed");
    };

    await runCommandJobTick("custom:err");

    expect(h.stored).toHaveLength(1);
    expect(h.stored[0].status).toBe("failed");
    expect(String(h.stored[0].error)).toBe("ssh: handshakefailed");
  });

  it("announces the per-line cap instead of silently shortening output", async () => {
    h.jobRows["custom:oneline"] = cmdJob("custom:oneline", { serverId: "srv1", command: "x" });
    h.execImpl = async () => ({ code: 0, output: "x".repeat(100_000) });

    await runCommandJobTick("custom:oneline");

    const stored = String(h.stored[0].output);
    expect(stored.length).toBeLessThan(100_000);
    expect(stored).toContain("truncated for storage");
  });
});
