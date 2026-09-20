/**
 * Command-job execution E2E — real runLoop / executeAttempt / repos / jobRunBus.
 * The ONLY faked boundary is SSH (sshManager) — you can't ssh to a box in CI.
 *
 * Covers success/failure, env injection, output cap, multi-server fan-out,
 * timeout, and FIX #2 — retries stream into ONE aggregate run row (stable id,
 * single terminal `complete`) instead of a new row per attempt.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Controllable fake SSH: `handler(serverId, cmd, onLine)` decides each attempt's
// output/exit + can emit log lines. vi.hoisted so the mock factory can see it.
const ssh = vi.hoisted(() => ({
  state: {
    retained: new Set<string>(),
    handler: null as
      | null
      | ((
          serverId: string,
          cmd: string,
          onLine: (e: { message: string; level: "info" | "warn" | "error" }) => void,
          options?: { signal?: AbortSignal },
        ) => Promise<{ code: number; output: string }> | { code: number; output: string }),
  },
}));

vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: {
    retain: (id: string) => { ssh.state.retained.add(id); },
    release: (id: string) => { ssh.state.retained.delete(id); },
    withExecutor: async (
      serverId: string,
      fn: (ex: { streamExec: (cmd: string, onLine: (e: unknown) => void, options?: { signal?: AbortSignal }) => Promise<{ code: number; output: string }> }) => unknown,
    ) =>
      fn({
        streamExec: async (cmd: string, onLine: (e: unknown) => void, options?: { signal?: AbortSignal }) =>
          ssh.state.handler
            ? await ssh.state.handler(serverId, cmd, onLine as (e: { message: string; level: "info" | "warn" | "error" }) => void, options)
            : { code: 0, output: "" },
      }),
  },
}));

import { db, schema, repos, resetJobs, installFakeRunner } from "./_harness";
import { startCommandRun } from "@repo/platform/engine/modules/jobs/job-command";
import { jobRunBus, type JobRunEvent } from "@repo/platform/engine/modules/jobs/job-run.sse";
import type { Job } from "@repo/db";

installFakeRunner();
beforeEach(async () => {
  await resetJobs();
  ssh.state.handler = null;
  ssh.state.retained.clear();
});

let jseq = 0;
async function makeCommandJob(cfg: Record<string, unknown>): Promise<Job> {
  const key = `custom:exec${jseq++}`;
  const now = new Date();
  await db.insert(schema.job).values({
    id: `job_${jseq}`,
    key,
    kind: "custom",
    label: "cmd",
    scheduleType: "manual",
    enabled: true,
    actionType: "command",
    actionConfig: cfg,
    dependsOn: [],
    triggerEvents: [],
    createdAt: now,
    updatedAt: now,
  });
  return (await repos.job.findByKey(key))!;
}

function waitForRun(runId: string, ms = 3000): Promise<NonNullable<Awaited<ReturnType<typeof repos.jobRun.findById>>>> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = async () => {
      const run = await repos.jobRun.findById(runId);
      if (run && run.status !== "running") return resolve(run);
      if (Date.now() - start > ms) return reject(new Error(`run ${runId} did not finish`));
      setTimeout(() => void poll(), 10);
    };
    void poll();
  });
}

describe("command jobs — execution", () => {
  it("runs a command to success, capturing output", async () => {
    ssh.state.handler = (_sid, _cmd, onLine) => {
      onLine({ message: "hello", level: "info" });
      return { code: 0, output: "hello\ndone" };
    };
    const job = await makeCommandJob({ command: "echo hello", serverIds: ["srv-1"] });
    const runId = await startCommandRun(job);
    const run = await waitForRun(runId);
    expect(run.status).toBe("success");
    expect(run.output).toContain("done");
    expect((run.summary as { exitCode: number }).exitCode).toBe(0);
  });

  it("marks a non-zero exit as failed with the exit code", async () => {
    ssh.state.handler = () => ({ code: 3, output: "boom" });
    const job = await makeCommandJob({ command: "false", serverIds: ["srv-1"] });
    const run = await waitForRun(await startCommandRun(job));
    expect(run.status).toBe("failed");
    expect(run.error).toContain("3");
    expect(run.output).toContain("boom");
  });

  it("injects env as shell-quoted exports before the command", async () => {
    let seenCmd = "";
    ssh.state.handler = (_sid, cmd) => {
      seenCmd = cmd;
      return { code: 0, output: "" };
    };
    const job = await makeCommandJob({ command: "printenv FOO", serverIds: ["srv-1"], env: { FOO: "bar baz" } });
    await waitForRun(await startCommandRun(job));
    expect(seenCmd).toContain("export FOO='bar baz'");
    expect(seenCmd).toContain("printenv FOO");
  });

  it("caps stored output at 200k", async () => {
    ssh.state.handler = () => ({ code: 0, output: "x".repeat(300_000) });
    const job = await makeCommandJob({ command: "yes", serverIds: ["srv-1"] });
    const run = await waitForRun(await startCommandRun(job));
    expect(run.output!.length).toBeLessThanOrEqual(200_000);
  });

  it("fans out across servers and aggregates (fail if any fails)", async () => {
    ssh.state.handler = (sid) => (sid === "srv-a" ? { code: 0, output: "A-ok" } : { code: 1, output: "B-bad" });
    const job = await makeCommandJob({ command: "hostname", serverIds: ["srv-a", "srv-b"] });
    const run = await waitForRun(await startCommandRun(job));
    expect(run.status).toBe("failed");
    expect(run.serverId).toBeNull(); // aggregate run, not tagged to one server
    expect(run.output).toContain("A-ok");
    expect(run.output).toContain("B-bad");
  });

  it("aborts a timed-out command and holds its connection until execution settles", async () => {
    let aborted = false;
    let heldDuringCancellation = false;
    ssh.state.handler = (sid, _cmd, _onLine, options) => new Promise(resolve => {
      options?.signal?.addEventListener("abort", () => {
        aborted = true;
        setTimeout(() => {
          heldDuringCancellation = ssh.state.retained.has(sid);
          resolve({ code: 1, output: "cancelled" });
        }, 25);
      }, { once: true });
    });
    const job = await makeCommandJob({ command: "sleep 999", serverIds: ["srv-1"], timeoutMs: 50 });
    const run = await waitForRun(await startCommandRun(job));
    expect(run.status).toBe("failed");
    expect(run.error?.toLowerCase()).toContain("timed out");
    expect(aborted).toBe(true);
    expect(heldDuringCancellation).toBe(true);
    expect(ssh.state.retained.size).toBe(0);
  });
});

describe("command jobs — fix #2: retries stream into one aggregate run", () => {
  it("retries append to the SAME run id and end at the final status", async () => {
    let calls = 0;
    ssh.state.handler = (_sid, _cmd, onLine) => {
      calls++;
      onLine({ message: `attempt-${calls}`, level: "info" });
      return calls === 1 ? { code: 1, output: "fail-1" } : { code: 0, output: "ok-2" };
    };
    const job = await makeCommandJob({ command: "flaky", serverIds: ["srv-1"], retry: { maxAttempts: 2, backoffSeconds: 0 } });

    const runId = await startCommandRun(job);
    const run = await waitForRun(runId);

    // The returned run id follows the retries to the eventual success.
    expect(run.id).toBe(runId);
    expect(run.status).toBe("success");
    expect((run.summary as { attempts: number }).attempts).toBe(2);
    expect(run.output).toContain("fail-1");
    expect(run.output).toContain("ok-2");

    // Exactly ONE run row for the job (aggregate), not one per attempt.
    const all = await repos.jobRun.listRecent({ jobId: job.key, limit: 50 });
    expect(all.length).toBe(1);
  });

  it("the SSE stream for the returned id spans attempts and gets ONE terminal complete", async () => {
    let calls = 0;
    ssh.state.handler = (_sid, _cmd, onLine) => {
      calls++;
      onLine({ message: `line-${calls}`, level: "info" });
      return calls === 1 ? { code: 1, output: "f" } : { code: 0, output: "s" };
    };
    const job = await makeCommandJob({ command: "flaky", serverIds: ["srv-1"], retry: { maxAttempts: 2, backoffSeconds: 0 } });

    const runId = await startCommandRun(job);
    const events: JobRunEvent[] = [];
    jobRunBus.subscribe(runId, (e) => events.push(e));

    await waitForRun(runId);
    await new Promise((r) => setTimeout(r, 20)); // let the terminal event flush

    const completes = events.filter((e) => e.type === "complete");
    expect(completes.length).toBe(1); // not closed at attempt-1's failure
    expect(completes[0]).toMatchObject({ type: "complete", status: "success" });
    // logs from BOTH attempts reached the same stream
    const logs = events.filter((e): e is Extract<JobRunEvent, { type: "log" }> => e.type === "log").map((e) => e.line);
    expect(logs).toContain("line-1");
    expect(logs).toContain("line-2");
  });
});
