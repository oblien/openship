import "./_env"; // set INTERNAL_TOKEN etc. before job-command → encryption → config/env loads
import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared mutable state for the mocks (hoisted so the factories can close over it).
const h = vi.hoisted(() => ({
  jobRows: {} as Record<string, unknown>,
  finishCalls: [] as Array<Record<string, unknown>>,
  startedRuns: [] as Array<Record<string, unknown>>,
  cmds: [] as string[],
  notifications: [] as Array<Record<string, unknown>>,
  members: [] as Array<{ organizationId: string }>,
  retain: 0,
  release: 0,
  runSeq: 0,
  execImpl: null as
    | null
    | ((
        cmd: string,
        onLog: (e: { message: string; level: string }) => void,
        serverId: string,
      ) => Promise<{ code: number; output: string }>),
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
        const row = { id: `jrun_${++h.runSeq}`, ...d };
        h.startedRuns.push(row);
        return row;
      },
      finish: async (id: string, data: Record<string, unknown>) => {
        h.finishCalls.push({ id, ...data });
      },
      listRecent: async () => [],
    },
    // Notification fan-out — controllable via h.members and h.notifications
    member: { listByUser: async () => h.members },
    notificationChannel: { findById: async () => null },
    notificationDelivery: {
      create: async (d: Record<string, unknown>) => {
        h.notifications.push(d);
      },
    },
    notificationSubscription: { listEnabledForDispatch: async () => [] },
  },
}));

vi.mock("@repo/platform/engine/lib/notification-dispatcher", () => ({
  notification: {
    emit: (input: Record<string, unknown>) => {
      h.notifications.push(input);
    },
  },
}));

vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: {
    retain: () => {
      h.retain++;
    },
    release: () => {
      h.release++;
    },
    withExecutor: async (serverId: string, fn: (ex: unknown) => Promise<unknown>) =>
      fn({
        streamExec: (cmd: string, onLog: (e: { message: string; level: string }) => void) => {
          h.cmds.push(cmd);
          return h.execImpl!(cmd, onLog, serverId);
        },
      }),
  },
}));

import { runCommandJobTick } from "@repo/platform/engine/modules/jobs/job-command";
import { jobRunBus, type JobRunEvent } from "@repo/platform/engine/modules/jobs/job-run.sse";
import { createRunBus } from "../../../src/lib/run-sse";

const cmdJob = (key: string, cfg: Record<string, unknown>) => ({
  key,
  enabled: true,
  actionType: "command",
  actionConfig: cfg,
});

beforeEach(() => {
  h.finishCalls.length = 0;
  h.startedRuns.length = 0;
  h.cmds.length = 0;
  h.notifications.length = 0;
  h.members.length = 0;
  h.jobRows = {};
  h.retain = 0;
  h.release = 0;
  h.runSeq = 0;
  h.execImpl = null;
});

describe("custom job executor (runCommandJobTick)", () => {
  it("success: captures output, exit 0 → success, retains+releases the connection", async () => {
    h.jobRows["custom:ok"] = cmdJob("custom:ok", { serverId: "srv1", command: "echo hi" });
    const seen: JobRunEvent[] = [];
    const unsub = jobRunBus.subscribe("jrun_1", (e) => seen.push(e));
    h.execImpl = async (_cmd, onLog) => {
      onLog({ message: "hi", level: "info" });
      return { code: 0, output: "hi\n" };
    };

    await runCommandJobTick("custom:ok");
    unsub();

    expect(h.finishCalls).toHaveLength(1);
    const f = h.finishCalls[0];
    expect(f.status).toBe("success");
    expect(f.output).toBe("hi\n");
    expect(f.summary).toMatchObject({ exitCode: 0, attempts: 1 });
    expect(f.error).toBeUndefined();
    // connection retained + released exactly once (no leak)
    expect(h.retain).toBe(1);
    expect(h.release).toBe(1);
    // streamed a live log line + a terminal complete
    expect(seen.some((e) => e.type === "log" && e.line === "hi")).toBe(true);
    expect(seen.some((e) => e.type === "complete" && e.status === "success")).toBe(true);
  });

  it("non-zero exit → failed with an exit-code error, still stores output", async () => {
    h.jobRows["custom:bad"] = cmdJob("custom:bad", { serverId: "srv1", command: "false" });
    h.execImpl = async () => ({ code: 2, output: "boom\n" });

    await runCommandJobTick("custom:bad");

    const f = h.finishCalls[0];
    expect(f.status).toBe("failed");
    expect(f.output).toBe("boom\n");
    expect(String(f.error)).toContain("code 2");
    expect(h.release).toBe(1); // released even on failure
  });

  it("executor throws → failed with the error message, connection released", async () => {
    h.jobRows["custom:throw"] = cmdJob("custom:throw", { serverId: "srv1", command: "x" });
    h.execImpl = async () => {
      throw new Error("ssh handshake failed");
    };

    await runCommandJobTick("custom:throw");

    const f = h.finishCalls[0];
    expect(f.status).toBe("failed");
    expect(String(f.error)).toContain("ssh handshake failed");
    expect(h.release).toBe(1);
  });

  it("missing serverId/command → failed before any exec (never retains)", async () => {
    h.jobRows["custom:empty"] = cmdJob("custom:empty", {});
    await runCommandJobTick("custom:empty");
    const f = h.finishCalls[0];
    expect(f.status).toBe("failed");
    expect(String(f.error).toLowerCase()).toContain("server");
    expect(h.retain).toBe(0);
  });

  it("caps stored output for a chatty command (no unbounded row growth)", async () => {
    h.jobRows["custom:big"] = cmdJob("custom:big", { serverId: "srv1", command: "yes" });
    h.execImpl = async () => ({ code: 0, output: "x".repeat(500_000) });
    await runCommandJobTick("custom:big");
    expect(String(h.finishCalls[0].output).length).toBeLessThanOrEqual(200_000);
  });

  it("ignores a non-command row (no run started)", async () => {
    h.jobRows["ssl:renew"] = { key: "ssl:renew", actionType: "builtin", actionConfig: null };
    await runCommandJobTick("ssl:renew");
    expect(h.startedRuns).toHaveLength(0);
  });

  it("retries a failing attempt into ONE aggregate run row (fix #2)", async () => {
    h.jobRows["custom:retry"] = cmdJob("custom:retry", {
      serverId: "srv1",
      command: "flaky",
      retry: { maxAttempts: 2, backoffSeconds: 0 },
    });
    let n = 0;
    h.execImpl = async () => (++n === 1 ? { code: 1, output: "boom" } : { code: 0, output: "ok" });

    await runCommandJobTick("custom:retry");

    // Retries aggregate: the row is finished ONCE with the final status, the
    // attempt count in summary, and both attempts' output — so run-now's id +
    // SSE stream span every attempt (fix #2).
    expect(h.finishCalls).toHaveLength(1);
    const f = h.finishCalls[0];
    expect(f.status).toBe("success");
    expect((f.summary as { attempts: number }).attempts).toBe(2);
    expect(String(f.output)).toContain("boom");
    expect(String(f.output)).toContain("ok");
    // still one SSH connection retained+released per attempt (no leak)
    expect(h.retain).toBe(2);
    expect(h.release).toBe(2);
    // only one run row was ever opened (the aggregate)
    expect(h.startedRuns).toHaveLength(1);
  });

  it("stops retrying after a success (no wasted attempts)", async () => {
    h.jobRows["custom:ok2"] = cmdJob("custom:ok2", {
      serverId: "srv1",
      command: "ok",
      retry: { maxAttempts: 3, backoffSeconds: 0 },
    });
    h.execImpl = async () => ({ code: 0, output: "" });
    await runCommandJobTick("custom:ok2");
    expect(h.finishCalls).toHaveLength(1);
  });

  it("prepends shell-quoted env vars and escapes quotes (no injection)", async () => {
    h.jobRows["custom:env"] = cmdJob("custom:env", {
      serverId: "srv1",
      command: "run.sh",
      env: { FOO: "bar baz", Q: "a'b" },
    });
    h.execImpl = async () => ({ code: 0, output: "" });

    await runCommandJobTick("custom:env");

    const cmd = h.cmds[0];
    expect(cmd).toContain("export FOO='bar baz'");
    expect(cmd).toContain("export Q='a'\\''b'"); // single-quote closed, escaped, reopened
    expect(cmd.endsWith("run.sh")).toBe(true);
  });

  it("multi-server: runs on each server, aggregates output + fails if any fails", async () => {
    h.jobRows["custom:multi"] = cmdJob("custom:multi", {
      serverIds: ["srvA", "srvB"],
      command: "uptime",
    });
    h.execImpl = async (_cmd, _onLog, serverId) => ({
      code: serverId === "srvB" ? 1 : 0,
      output: `out-${serverId}`,
    });

    await runCommandJobTick("custom:multi");

    expect(h.retain).toBe(2); // one connection per server
    expect(h.release).toBe(2);
    expect(h.finishCalls).toHaveLength(1); // one aggregate run row
    const f = h.finishCalls[0];
    expect(f.status).toBe("failed"); // any server non-zero → failed
    expect(String(f.output)).toContain("srvA");
    expect(String(f.output)).toContain("srvB");
  });

  it("failure emits notification with jobName, exitCode, error, duration, and logExcerpt", async () => {
    h.members.push({ organizationId: "org_1" });
    h.jobRows["custom:fail"] = {
      ...cmdJob("custom:fail", { serverId: "srv1", command: "fail.sh" }),
      label: "Audit unconfigured backups",
      createdBy: "user_1",
    };
    h.execImpl = async () => ({
      code: 17,
      output: "ALERT: Found 1 project(s) without backup configuration!\n",
    });

    await runCommandJobTick("custom:fail");

    const failedEmit = h.notifications.find((n) => n.eventType === "job_run.failed");
    expect(failedEmit).toBeDefined();
    expect(failedEmit?.payload).toMatchObject({
      jobName: "Audit unconfigured backups",
      label: "Audit unconfigured backups",
      jobKey: "custom:fail",
      status: "failed",
      exitCode: 17,
      errorMessage: "Command exited with code 17",
      logExcerpt: "ALERT: Found 1 project(s) without backup configuration!",
    });
    expect(typeof (failedEmit?.payload as Record<string, unknown>)?.durationMs).toBe("number");
    expect(h.finishCalls[0].summary).toMatchObject({ exitCode: 17 });
  });

  it("bounds and scrubs notification output while retaining the failure tail", async () => {
    h.members.push({ organizationId: "org_1" });
    h.jobRows["custom:logs"] = {
      ...cmdJob("custom:logs", { serverId: "srv1", command: "run.sh" }),
      label: "Backup",
      createdBy: "user_1",
    };
    h.execImpl = async () => ({
      code: 2,
      output: `${"x".repeat(4000)}\npostgres://user:do-not-deliver@db/app\nlast failure`,
    });

    await runCommandJobTick("custom:logs");

    const event = h.notifications.find((n) => n.eventType === "job_run.failed");
    const excerpt = String((event?.payload as Record<string, unknown>)?.logExcerpt);
    expect(excerpt.length).toBeLessThanOrEqual(2000);
    expect(excerpt).toMatch(/last failure$/);
    expect(excerpt).not.toContain("do-not-deliver");
  });
});

describe("run SSE bus (createRunBus)", () => {
  it("delivers events to subscribers and closes the channel after a terminal event", () => {
    const bus = createRunBus<{ type: string; n?: number }>((e) => e.type === "complete");
    const got: number[] = [];
    bus.subscribe("r1", (e) => e.n != null && got.push(e.n));
    bus.publish("r1", { type: "log", n: 1 });
    bus.publish("r1", { type: "log", n: 2 });
    bus.publish("r1", { type: "complete" });
    expect(got).toEqual([1, 2]);
    // terminal publish schedules listener removal on the next tick
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        bus.publish("r1", { type: "log", n: 3 }); // no live subscriber → dropped
        expect(got).toEqual([1, 2]);
        resolve();
      });
    });
  });

  it("isolates channels by id", () => {
    const bus = createRunBus<{ type: string; id: string }>((e) => e.type === "complete");
    const a: string[] = [];
    bus.subscribe("A", (e) => a.push(e.id));
    bus.publish("B", { type: "log", id: "b" });
    expect(a).toEqual([]);
  });
});
