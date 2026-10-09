import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  createRepositories,
  eq,
  schema,
  type DatabaseConnection,
} from "@repo/db/factory";
import type { ActionRun, ActionRunner } from "@repo/db";
import { AppError, generateId, type ActionJobResult, type ActionWorkerRequest } from "@repo/core";
import { ActionController, type ActionControllerPorts } from "./controller";
import { parseActionWorkflow } from "./workflow";

let connection: DatabaseConnection;
let repo: ReturnType<typeof createRepositories>["actions"];
const authority = (org: string) => ({
  version: 1 as const,
  userId: "actor",
  organizationId: org,
  token: null,
  restrictions: null,
});
const yaml = `name: CI\non: workflow_dispatch\njobs:\n  first:\n    runs-on: [self-hosted, macos]\n    steps:\n      - run: echo hello\n  second:\n    needs: first\n    runs-on: [self-hosted, macos]\n    steps:\n      - run: echo done\n`;
beforeAll(async () => {
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  repo = createRepositories(connection.db, {
    encrypt: (value) => value,
    decrypt: (value) => value,
  }).actions;
}, 60_000);
afterAll(async () => {
  await connection?.close();
});

async function fixture(source = yaml, cloud = false) {
  const org = generateId("org");
  const server = generateId("srv");
  await connection.db.insert(schema.organization).values({ id: org, name: org });
  await connection.db
    .insert(schema.servers)
    .values({ id: server, organizationId: org, sshHost: "test.example", sshUser: "runner" });
  const runner = await repo.saveRunner({
    id: generateId("runner"),
    organizationId: org,
    name: "Mac",
    serverId: cloud ? null : server,
    cloudPoolId: cloud ? "ci-test" : null,
    config: {
      mode: "native",
      labels: [],
      image: null,
      cpu: 1,
      memoryMb: 1024,
      maxParallel: 1,
      allowDockerSocket: false,
    },
    capabilities: {
      os: "macos",
      architecture: "arm64",
      docker: false,
      node: true,
      git: true,
      version: "15",
      distribution: null,
    },
    enabled: true,
  });
  const workflow = await repo.saveWorkflow({
    id: generateId("wf"),
    organizationId: org,
    name: "CI",
    owner: "acme",
    repo: "app",
    path: ".github/workflows/ci.yml",
    ref: "main",
    source,
    definition: await parseActionWorkflow(source),
    runnerIds: [runner.id],
    authority: authority(org),
  });
  const plan = await parseActionWorkflow(source);
  const input = {
    id: generateId("run"),
    organizationId: org,
    workflowId: workflow.id,
    idempotencyKey: "dispatch-one",
    source,
    plan,
    revision: "a".repeat(40),
    ref: "refs/heads/main",
    eventName: "workflow_dispatch",
    event: {},
    actor: "actor",
    authority: authority(org),
    configuration: {
      owner: "acme",
      repo: "app",
      path: workflow.path,
      defaultBranch: "main",
      runnerIds: [runner.id],
      variables: {},
      secrets: {},
    },
  };
  const run = await repo.createRun(input);
  return { org, runner, workflow, run, input };
}

function engine(options: { provisioning?: boolean } = {}) {
  const executions = new Map<
    string,
    { request: ActionWorkerRequest; result?: ActionJobResult; cancelled: boolean }
  >();
  const ports: ActionControllerPorts = {
    repo,
    authorize: vi.fn(async () => {}),
    secrets: async () => ({}),
    cleanup: vi.fn(async () => true),
    check: vi.fn(async (_run, job) => ({ id: job.id, error: null })),
    reportError: vi.fn(),
    open: vi.fn(async (_run, job) =>
      options.provisioning
        ? null
        : {
            binary: "/runner",
            directory: `/jobs/${job.id}`,
            release: async () => {},
            worker: {
              inspect: async (_binary: string, _dir: string, after = 0) => {
                const value = executions.get(job.id);
                if (!value) return { state: "idle" as const, events: [], hasMore: false };
                return {
                  state: value.result ? ("finished" as const) : ("running" as const),
                  hasMore: false,
                  result: value.result,
                  events:
                    after < 1
                      ? [
                          {
                            version: 1 as const,
                            sequence: 1,
                            time: new Date().toISOString(),
                            type: "log" as const,
                            message: "safe output",
                          },
                        ]
                      : [],
                };
              },
              start: vi.fn(async (_binary, _dir, request) => {
                if (executions.has(job.id)) throw new Error("Attempt executed twice");
                executions.set(job.id, { request, cancelled: false });
              }),
              cancel: async () => {
                const state = executions.get(job.id)!;
                state.cancelled = true;
              },
              clean: async () => {
                if (!executions.get(job.id)?.result) throw new Error("Worker has not exited");
              },
            },
          },
    ),
  };
  return {
    ports,
    executions,
    controller: new ActionController(ports),
    finish(id: string, conclusion: ActionJobResult["conclusion"] = "success", outputs = {}) {
      executions.get(id)!.result = { conclusion, outputs, steps: {} };
    },
  };
}
const reconcile = (engine: { controller: ActionController }, run: ActionRun) =>
  engine.controller.reconcile(run.organizationId, run.id);

describe("durable Actions controller", () => {
  it("keeps a reserved destination immutable and rejects stale capability selection", async () => {
    const f = await fixture();
    const e = engine({ provisioning: true });
    await reconcile(e, f.run);
    const [job] = await repo.jobs(f.org, f.run.id);
    expect(job?.runnerId).toBe(f.runner.id);
    await expect(
      repo.saveRunner({ ...f.runner, config: { ...f.runner.config, cpu: 8 } }),
    ).rejects.toMatchObject({ code: "ACTIONS_RUNNER_BUSY" });
    expect((await repo.runner(f.org, f.runner.id))?.config.cpu).toBe(1);
    await repo.disableRunner(f.org, f.runner.id);
    await repo.recordRunnerProbe(f.org, f.runner.id, {
      capabilities: f.runner.capabilities,
      error: null,
      checkedAt: new Date(),
    });
    expect((await repo.runner(f.org, f.runner.id))?.enabled).toBe(false);

    const stale = await fixture();
    await repo.claimRun(stale.org, stale.run.id, "selection-test");
    const spec = { ...job!.spec!, jobId: "first" };
    await repo.expandJobs(stale.org, stale.run.id, "selection-test", "first", [spec]);
    const [waiting] = await repo.jobs(stale.org, stale.run.id);
    await repo.saveRunner({
      ...stale.runner,
      config: { ...stale.runner.config, mode: "container", image: "node:22" },
      capabilities: { ...stale.runner.capabilities!, os: "linux", docker: true },
    });
    expect(
      await repo.reserveRunner(stale.org, waiting!.id, stale.runner.id, "selection-test"),
    ).toBe(false);
    expect((await repo.job(stale.org, waiting!.id))?.runnerId).toBeNull();
  });

  it("does not accept a new webhook dispatch after the workflow was disabled", async () => {
    const f = await fixture();
    await repo.disableWorkflow(f.org, f.workflow.id);
    expect((await repo.createRun({ ...f.input, id: generateId("run") })).id).toBe(f.run.id);
    await expect(
      repo.createRun({ ...f.input, id: generateId("run"), idempotencyKey: "late-dispatch" }),
    ).rejects.toMatchObject({ code: "ACTIONS_WORKFLOW_DISABLED" });
  });

  it("bounds queued work per organization without rejecting an existing dispatch retry", async () => {
    const { run, input } = await fixture();
    await connection.db.insert(schema.actionRun).values(
      Array.from({ length: 99 }, (_, i) => ({
        ...input,
        id: generateId("run"),
        number: i + 2,
        idempotencyKey: `queued-${i}`,
      })),
    );
    expect((await repo.createRun({ ...input, id: generateId("run") })).id).toBe(run.id);
    await expect(
      repo.createRun({ ...input, id: generateId("run"), idempotencyKey: "over-limit" }),
    ).rejects.toMatchObject({ code: "ACTIONS_QUEUE_FULL", statusCode: 429 });
    expect((await fixture()).run.status).toBe("queued");
  });

  it("retains active runs, stored artifacts and retry ancestry while pruning expired history", async () => {
    const f = await fixture();
    const past = new Date(Date.now() - 31 * 86_400_000);
    const insert = (key: string, extra = {}) =>
      repo.createRun({ ...f.input, id: generateId("run"), idempotencyKey: key, ...extra });
    const expired = await insert("expired", {
      status: "success",
      finishedAt: past,
      settledAt: past,
    });
    const stored = await insert("stored", { status: "success", finishedAt: past, settledAt: past });
    const parent = await insert("parent", { status: "failure", finishedAt: past, settledAt: past });
    await insert("retry", { originalRunId: parent.id });
    const jobId = generateId("job");
    const destinationId = generateId("dst");
    await connection.db
      .insert(schema.actionJob)
      .values({
        id: jobId,
        runId: stored.id,
        organizationId: f.org,
        jobKey: "first",
        matrixIndex: 0,
      });
    await connection.db
      .insert(schema.backupDestination)
      .values({ id: destinationId, organizationId: f.org, name: "Artifacts", kind: "local" });
    await connection.db
      .insert(schema.actionStorageObject)
      .values({
        organizationId: f.org,
        runId: stored.id,
        jobId,
        destinationId,
        kind: "artifact",
        repository: "acme/app",
        ref: "refs/heads/main",
        name: "build",
        key: "test-build",
        reservedBytes: 1,
        maxBytes: 1,
        expiresAt: past,
      });
    await repo.pruneRuns(new Date(Date.now() - 30 * 86_400_000));
    expect(await repo.run(f.org, expired.id)).toBeUndefined();
    for (const id of [f.run.id, stored.id, parent.id])
      expect(await repo.run(f.org, id)).toBeDefined();
    await connection.db
      .delete(schema.actionStorageObject)
      .where(eq(schema.actionStorageObject.runId, stored.id));
    await repo.pruneRuns(new Date());
    expect(await repo.run(f.org, stored.id)).toBeUndefined();
  });

  it("applies the migration and deduplicates an uncertain dispatch without crossing organizations", async () => {
    const { run, input } = await fixture();
    expect((await repo.createRun({ ...input, id: generateId("run") })).id).toBe(run.id);
    expect(await repo.run("different-org", run.id)).toBeUndefined();
    expect(await repo.runByKey("different-org", input.idempotencyKey)).toBeUndefined();
    const other = await fixture();
    await expect(
      repo.createRun({
        ...input,
        id: generateId("run"),
        workflowId: other.workflow.id,
        idempotencyKey: "cross-tenant",
      }),
    ).rejects.toThrow();
  });

  it("resumes logs and dependencies after a controller restart without replaying commands", async () => {
    const { run, org } = await fixture();
    const e = engine();
    await reconcile(e, run);
    const [first] = await repo.jobs(org, run.id);
    expect(e.executions.size).toBe(1);
    await reconcile(e, run);
    expect((await repo.events(org, first!.id)).map((row) => row.event.message)).toEqual([
      "safe output",
    ]);
    e.controller = new ActionController(e.ports);
    e.finish(first!.id, "success", { build: "42" });
    await reconcile(e, run);
    await reconcile(e, run);
    const second = (await repo.jobs(org, run.id)).find((job) => job.jobKey === "second")!;
    expect(e.executions.get(second.id)?.request.needs.first).toEqual({
      result: "success",
      outputs: { build: "42" },
    });
    expect((await repo.events(org, first!.id)).length).toBe(1);
    e.finish(second.id);
    await reconcile(e, run);
    expect((await repo.run(org, run.id))?.status).toBe("success");
    expect((await repo.run(org, run.id))?.settledAt).not.toBeNull();
    expect(e.ports.reportError).not.toHaveBeenCalled();
  });

  it("does not release capacity or report cancellation until the worker has stopped", async () => {
    const { run, org, runner } = await fixture();
    const e = engine();
    await reconcile(e, run);
    const [job] = await repo.jobs(org, run.id);
    await repo.requestCancel(org, run.id);
    await reconcile(e, run);
    expect(e.executions.get(job!.id)?.cancelled).toBe(true);
    expect((await repo.job(org, job!.id))?.status).toBe("cancelling");
    expect(await repo.runnerBusy(org, runner.id)).toBe(true);
    e.finish(job!.id, "cancelled");
    await reconcile(e, run);
    expect(await repo.runnerBusy(org, runner.id)).toBe(false);
    expect((await repo.run(org, run.id))?.status).toBe("cancelled");
  });

  it("cleans a cancelled provisioning VM without starting its job", async () => {
    const { run, org, runner } = await fixture(yaml, true);
    const e = engine({ provisioning: true });
    e.ports.cleanup = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    await reconcile(e, run);
    expect(e.ports.open).toHaveBeenCalledOnce();
    await repo.requestCancel(org, run.id);
    await reconcile(e, run);
    expect(e.ports.cleanup).toHaveBeenCalledOnce();
    expect(await repo.runnerBusy(org, runner.id)).toBe(true);
    expect((await repo.run(org, run.id))?.settledAt).toBeNull();
    expect(e.ports.reportError).not.toHaveBeenCalled();
    await new ActionController(e.ports).reconcile(org, run.id);
    expect(e.ports.cleanup).toHaveBeenCalledTimes(2);
    expect(e.executions.size).toBe(0);
    expect(await repo.runnerBusy(org, runner.id)).toBe(false);
    expect((await repo.run(org, run.id))?.status).toBe("cancelled");
  });

  it("requires fork approval and never selects a persistent host for untrusted code", async () => {
    const { org, input } = await fixture();
    const e = engine();
    const run = await repo.createRun({
      ...input,
      id: generateId("run"),
      idempotencyKey: "fork",
      untrusted: true,
      status: "waiting",
    });
    await reconcile(e, run);
    expect(e.ports.open).not.toHaveBeenCalled();
    await repo.approve(org, run.id, "approver");
    await reconcile(e, run);
    expect(e.ports.open).not.toHaveBeenCalled();
    const [job] = await repo.jobs(org, run.id);
    expect(job?.status).toBe("waiting");
  });

  it("fences concurrent controllers and preserves a failed job's always() dependent", async () => {
    const { run, org } = await fixture(
      yaml.replace("    needs: first", "    needs: first\n    if: always()"),
    );
    const e = engine();
    const other = new ActionController(e.ports);
    await Promise.all([reconcile(e, run), other.reconcile(org, run.id)]);
    expect(e.executions.size).toBe(1);
    const [first] = await repo.jobs(org, run.id);
    e.finish(first!.id, "failure");
    await reconcile(e, run);
    await reconcile(e, run);
    const second = (await repo.jobs(org, run.id)).find((job) => job.jobKey === "second")!;
    expect(e.executions.has(second.id)).toBe(true);
    e.finish(second.id);
    await reconcile(e, run);
    expect((await repo.run(org, run.id))?.status).toBe("failure");
  });

  it("honors a cancellation arriving while job credentials are being prepared", async () => {
    const { run, org, runner } = await fixture();
    const e = engine();
    e.ports.secrets = async () => {
      await repo.requestCancel(org, run.id);
      return {};
    };
    await reconcile(e, run);
    expect(e.executions.size).toBe(0);
    await reconcile(e, run);
    expect((await repo.run(org, run.id))?.status).toBe("cancelled");
    expect(await repo.runnerBusy(org, runner.id)).toBe(false);
  });

  it("stops new execution during controller shutdown and lets the successor resume the same attempt", async () => {
    const { run, org } = await fixture();
    const e = engine();
    const stopping = new AbortController();
    e.ports.secrets = async () => {
      stopping.abort();
      return {};
    };
    await e.controller.reconcile(org, run.id, stopping.signal);
    const [job] = await repo.jobs(org, run.id);
    expect(e.executions.size).toBe(0);
    expect(job!.workerStartedAt).toBeNull();
    expect(job!.finishedAt).toBeNull();
    expect((await repo.run(org, run.id))!.leaseOwner).toBeNull();
    e.ports.secrets = async () => ({});
    const successor = new ActionController(e.ports);
    await successor.reconcile(org, run.id);
    expect(e.executions.size).toBe(1);
    expect(e.executions.has(job!.id)).toBe(true);
  });

  it("fails an invalid worker result and reclaims the attempt without replaying it", async () => {
    const { run, org, runner } = await fixture();
    const e = engine();
    await reconcile(e, run);
    const [job] = await repo.jobs(org, run.id);
    e.executions.get(job!.id)!.result = {
      conclusion: "success",
      outputs: null,
      steps: {},
    } as unknown as ActionJobResult;
    await reconcile(e, run);
    await reconcile(e, run);
    expect((await repo.job(org, job!.id))?.status).toBe("failure");
    expect((await repo.run(org, run.id))?.status).toBe("failure");
    expect(await repo.runnerBusy(org, runner.id)).toBe(false);
    expect(e.executions.size).toBe(1);
  });

  it("settles a lost disposable VM as a failed attempt instead of recreating its commands", async () => {
    const { run, org, runner } = await fixture(yaml, true);
    const e = engine();
    await reconcile(e, run);
    const [job] = await repo.jobs(org, run.id);
    e.ports.open = vi.fn(async () => {
      throw new AppError("The temporary worker was removed", 410, "ACTIONS_WORKER_LOST");
    });
    await reconcile(e, run);
    expect((await repo.job(org, job!.id))?.status).toBe("failure");
    expect(await repo.runnerBusy(org, runner.id)).toBe(true);
    await reconcile(e, run);
    expect(e.ports.open).toHaveBeenCalledOnce();
    expect(e.ports.cleanup).toHaveBeenCalledOnce();
    expect(await repo.runnerBusy(org, runner.id)).toBe(false);
    expect((await repo.run(org, run.id))?.status).toBe("failure");
  });

  it("keeps a finished Cloud worker's slot until deletion is confirmed", async () => {
    const { run, org, runner } = await fixture(yaml, true);
    const e = engine();
    await reconcile(e, run);
    const [job] = await repo.jobs(org, run.id);
    e.finish(job!.id);
    e.ports.cleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error("Deletion response uncertain"))
      .mockResolvedValue(true);
    await reconcile(e, run);
    expect((await repo.job(org, job!.id))?.status).toBe("success");
    expect((await repo.job(org, job!.id))?.error).toBeNull();
    expect(await repo.runnerBusy(org, runner.id)).toBe(true);
    const opens = vi.mocked(e.ports.open).mock.calls.length;
    await reconcile(e, run);
    expect((await repo.job(org, job!.id))?.cleanedAt).not.toBeNull();
    // The dependent job starts only after cleanup releases the single slot.
    expect(
      vi
        .mocked(e.ports.open)
        .mock.calls.slice(opens)
        .every(([, value]) => value.id !== job!.id),
    ).toBe(true);
  });

  it.each(["success", "failure"] as const)(
    "preserves a %s result while asynchronous Cloud deletion holds the runner slot",
    async (conclusion) => {
      const { run, org, runner } = await fixture(yaml, true);
      const e = engine();
      await reconcile(e, run);
      const [job] = await repo.jobs(org, run.id);
      e.finish(job!.id, conclusion);
      const originalError = conclusion === "failure" ? "The workflow step exited with code 1" : null;
      if (originalError) e.executions.get(job!.id)!.result!.error = originalError;
      e.ports.cleanup = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
      await reconcile(e, run);
      expect(await repo.job(org, job!.id)).toMatchObject({
        status: conclusion, error: originalError, cleanedAt: null,
      });
      expect(await repo.runnerBusy(org, runner.id)).toBe(true);
      expect(e.ports.reportError).not.toHaveBeenCalled();
      const successor = new ActionController(e.ports);
      await successor.reconcile(org, run.id);
      expect(await repo.job(org, job!.id)).toMatchObject({
        status: conclusion, error: originalError, cleanedAt: expect.any(Date),
      });
      expect(e.ports.cleanup).toHaveBeenCalledTimes(2);
    },
  );
});
