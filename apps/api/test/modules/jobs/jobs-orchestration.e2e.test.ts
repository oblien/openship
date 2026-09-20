/**
 * Jobs orchestration E2E — real service + real scheduling + real DB.
 *
 * Covers: cron registration on the runner (create → registered, disable →
 * removed), one-shot dispatch (runDueOnceJobs), a REAL builtin run-now
 * (jobs:run-prune against the in-memory DB), and dependency chaining
 * (A succeeds → B fires). SSH is the only fake.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const ssh = vi.hoisted(() => ({ state: { code: 0, output: "ok" } }));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: {
    retain: () => {},
    release: () => {},
    withExecutor: async (_sid: string, fn: (ex: { streamExec: (cmd: string, onLine: (e: unknown) => void) => Promise<{ code: number; output: string }> }) => unknown) =>
      fn({ streamExec: async () => ({ code: ssh.state.code, output: ssh.state.output }) }),
  },
}));

import { db, schema, repos, resetJobs, seedOwner, installFakeRunner } from "./_harness";
import * as jobService from "@repo/platform/engine/modules/jobs/job.service";
import { runDueOnceJobs } from "@repo/platform/engine/modules/jobs/job-command";

const runner = installFakeRunner();
let owner: Awaited<ReturnType<typeof seedOwner>>;

beforeEach(async () => {
  await resetJobs();
  ssh.state = { code: 0, output: "ok" };
  owner = await seedOwner();
});

let n = 0;
async function insertCommandJob(over: Record<string, unknown> = {}): Promise<string> {
  const key = `custom:orch${n++}`;
  const now = new Date();
  await db.insert(schema.job).values({
    id: `job_orch_${n}`,
    key,
    kind: "custom",
    label: "cmd",
    scheduleType: "manual",
    enabled: true,
    actionType: "command",
    actionConfig: { command: "run", serverIds: ["srv-1"] },
    dependsOn: [],
    triggerEvents: [],
    createdBy: owner.userId,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
  return key;
}

function waitFor(pred: () => Promise<boolean>, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = async () => {
      if (await pred()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("condition not met"));
      setTimeout(() => void poll(), 10);
    };
    void poll();
  });
}

describe("scheduling — cron registration", () => {
  it("registers a recurring job on the runner, and removes it when disabled", async () => {
    const job = await jobService.createCustomJob({
      label: "nightly",
      command: "backup.sh",
      serverIds: ["srv-1"],
      scheduleType: "recurring",
      cronExpression: "*/5 * * * *",
      createdBy: owner.userId,
    });
    expect(runner.recurring.has(job.key)).toBe(true);

    // computed next-run is surfaced on the view
    const view = await jobService.getJob(job.key);
    expect(view.nextRunAt).toBeTruthy();

    await jobService.updateJob(job.key, { enabled: false });
    expect(runner.recurring.has(job.key)).toBe(false);
  });

  it("does NOT register a manual job", async () => {
    const job = await jobService.createCustomJob({
      label: "on-demand",
      command: "deploy.sh",
      serverIds: ["srv-1"],
      scheduleType: "manual",
      createdBy: owner.userId,
    });
    expect(runner.recurring.has(job.key)).toBe(false);
  });
});

describe("one-shot dispatch (runDueOnceJobs)", () => {
  it("fires a due once-job and disables it; leaves a not-yet-due one alone", async () => {
    const due = await insertCommandJob({ scheduleType: "once", runAt: new Date(Date.now() - 60_000) });
    const future = await insertCommandJob({ scheduleType: "once", runAt: new Date(Date.now() + 3_600_000) });

    const { fired } = await runDueOnceJobs();
    expect(fired).toBe(1);

    // the due job ran + was disabled; the future one is untouched
    await waitFor(async () => (await repos.jobRun.listRecent({ jobId: due, limit: 1 })).length > 0);
    expect((await repos.job.findByKey(due))?.enabled).toBe(false);
    expect((await repos.jobRun.listRecent({ jobId: future, limit: 1 })).length).toBe(0);
    expect((await repos.job.findByKey(future))?.enabled).toBe(true);
  });
});

describe("builtin run-now (real system job)", () => {
  it("runs jobs:run-prune inline against the real DB and records a success run", async () => {
    const now = new Date();
    await db.insert(schema.job).values({
      id: "job_run_prune",
      key: "jobs:run-prune",
      kind: "system",
      label: "Prune runs",
      cronExpression: "23 4 * * *",
      scheduleType: "recurring",
      enabled: true,
      actionType: "builtin",
      dependsOn: [],
      triggerEvents: [],
      createdAt: now,
      updatedAt: now,
    });

    const result = await jobService.runJobNow("jobs:run-prune");
    expect(result.key).toBe("jobs:run-prune");

    const [run] = await repos.jobRun.listRecent({ jobId: "jobs:run-prune", limit: 1 });
    expect(run?.status).toBe("success");
    expect(run?.kind).toBe("system");
  });
});

describe("dependencies", () => {
  it("fires a dependent job once its dependency succeeds", async () => {
    const a = await insertCommandJob();
    const b = await insertCommandJob({ dependsOn: [a] });

    const rowA = (await repos.job.findByKey(a))!;
    await jobService.runJobNow(a); // command job → backgrounds runLoop (fake ssh success)

    // A succeeds → fireDependents → B gets a run of its own
    await waitFor(async () => (await repos.jobRun.listRecent({ jobId: a, limit: 1 }))[0]?.status === "success");
    await waitFor(async () => (await repos.jobRun.listRecent({ jobId: b, limit: 1 })).length > 0);
    void rowA;
  });
});
