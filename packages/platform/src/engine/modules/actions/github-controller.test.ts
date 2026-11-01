import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRepositories,
  schema,
  eq,
  type DatabaseConnection,
} from "@repo/db/factory";
import { generateId, actionRunnerAdmissionKey } from "@repo/core";
import { parseActionWorkflow } from "./workflow";
let connection: DatabaseConnection;
let repo: ReturnType<typeof createRepositories>["actions"];
const source = `name: Native\non: [push, workflow_dispatch]\njobs:\n  call:\n    uses: ./.github/workflows/shared.yml\n    secrets: inherit\n  release:\n    needs: call\n    runs-on: [self-hosted, openship, linux]\n    environment: production\n    permissions:\n      contents: write\n      id-token: write\n    steps:\n      - run: echo ok\n`;
beforeAll(async () => {
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  repo = createRepositories(connection.db, { encrypt: (v) => v, decrypt: (v) => v }).actions;
}, 60000);
afterAll(async () => {
  await connection?.close();
});
async function fixture() {
  const org = generateId("org");
  await connection.db.insert(schema.organization).values({ id: org, name: org });
  const runner = await repo.saveRunner({
    id: generateId("runner"),
    organizationId: org,
    name: "Temporary Linux",
    cloudPoolId: generateId("pool"),
    config: {
      mode: "container",
      image: "node:22",
      labels: [],
      maxParallel: 1,
      cpu: 1,
      memoryMb: 1024,
      allowDockerSocket: false,
    },
    capabilities: {
      os: "linux",
      architecture: "x64",
      docker: true,
      git: true,
      node: true,
      distribution: "ubuntu",
      version: "24.04",
    },
  });
  const plan = await parseActionWorkflow(source, ".github/workflows/ci.yml", "github");
  const authority = {
    version: 1 as const,
    userId: "operator",
    organizationId: org,
    token: null,
    restrictions: null,
  };
  const workflow = await repo.saveWorkflow({
    id: generateId("wf"),
    organizationId: org,
    controller: "github",
    githubWorkflowId: "1",
    owner: "test",
    repo: "private",
    name: "Native",
    ref: "main",
    path: ".github/workflows/ci.yml",
    source: null,
    definition: plan,
    runnerIds: [runner.id],
    authority,
    accessPolicy: {
      version: 1,
      audience: "owner",
      owner: { provider: "github", id: "42", login: "operator" },
      users: [],
      approval: "automatic",
      forks: "deny",
    },
  });
  const run = {
    id: generateId("run"),
    controller: "github" as const,
    organizationId: org,
    workflowId: workflow.id,
    number: 1,
    attempt: 1,
    github: {
      id: "42",
      workflowId: "1",
      url: "https://github.com/test/private/actions/runs/42",
      status: "queued",
      conclusion: null,
      updatedAt: "2026-10-10T00:00:00Z",
    },
    admission: {
      state: "allowed" as const,
      reason: "allowed" as const,
      key: "a".repeat(64),
      workflowVersion: workflow.updatedAt.toISOString(),
      runnerIds: [runner.id],
      runnerKeys: { [runner.id]: actionRunnerAdmissionKey(runner) },
    },
    idempotencyKey: "native-run",
    source,
    plan,
    authority,
    revision: "a".repeat(40),
    ref: "refs/heads/main",
    eventName: "push",
    event: {},
    actor: "operator",
    configuration: {
      owner: "test",
      repo: "private",
      path: workflow.path,
      defaultBranch: "main",
      runnerIds: [runner.id],
      variables: {},
      secrets: {},
    },
  };
  const job = {
    id: generateId("job"),
    organizationId: org,
    runId: run.id,
    jobKey: "release",
    matrixIndex: 0,
    github: {
      id: "50",
      url: "https://github.com/test/private/actions/runs/42/job/50",
      runnerId: null,
      runnerName: null,
      steps: [],
    },
    spec: {
      jobId: "release",
      name: "release",
      matrix: {},
      strategy: {},
      labels: ["self-hosted", "openship", "linux"],
      needs: {},
      timeoutSeconds: 60,
      continueOnError: false,
      failFast: false,
      maxParallel: 1,
      concurrency: null,
      permissions: {},
      requiresDocker: false,
    },
  };
  const session = {
    id: generateId("session"),
    organizationId: org,
    workflowId: workflow.id,
    runnerId: runner.id,
    demandJobId: job.id,
    repoOwner: "test",
    repoName: "private",
    runnerName: `openship-${generateId("runner")}`,
    spec: job.spec,
  };
  return { org, runner, workflow, run, job, session };
}
describe("GitHub-owned workflows", () => {
  it("allocates nothing before exact-attempt approval and preserves approval during synchronization", async () => {
    const f = await fixture();
    const admission = {
      ...f.run.admission,
      state: "approval_required" as const,
      reason: "approval_required" as const,
    };
    await repo.upsertGitHubRun(f.workflow, { ...f.run, admission }, [f.job]);
    expect(await repo.reserveRunnerSession(f.session)).toBeUndefined();
    await expect(repo.approve("another-org", f.run.id, "admin", admission.key)).rejects.toThrow(
      "not found",
    );
    await expect(repo.approve(f.org, f.run.id, "admin", "b".repeat(64))).rejects.toThrow("changed");
    await repo.approve(f.org, f.run.id, "admin", admission.key);
    await repo.upsertGitHubRun(f.workflow, { ...f.run, admission }, [f.job]);
    await repo.setRunAdmission(f.org, f.run.id, admission); // A slow pre-approval read.
    expect((await repo.run(f.org, f.run.id))?.admission?.state).toBe("allowed");
    expect(await repo.reserveRunnerSession(f.session)).toBeTruthy();
  });
  it("rejects stale approvals and allocations after a policy or destination changes", async () => {
    const f = await fixture();
    await repo.upsertGitHubRun(f.workflow, f.run, [f.job]);
    await repo.saveWorkflow({
      ...f.workflow,
      accessPolicy: { ...f.workflow.accessPolicy!, approval: "required" },
      updatedAt: new Date(f.workflow.updatedAt.getTime() + 1000),
    });
    await expect(repo.approve(f.org, f.run.id, "admin", f.run.admission.key)).rejects.toThrow(
      "changed",
    );
    expect(await repo.reserveRunnerSession(f.session)).toBeUndefined();
    const second = await fixture();
    await repo.upsertGitHubRun(second.workflow, second.run, [second.job]);
    await repo.saveRunner({ ...second.runner, config: { ...second.runner.config, cpu: 4 } });
    expect(await repo.reserveRunnerSession(second.session)).toBeUndefined();
  });
  it("cannot turn a blocked actor into an allowed run by replaying an older approval", async () => {
    const f = await fixture();
    const admission = {
      ...f.run.admission,
      state: "approval_required" as const,
      reason: "approval_required" as const,
    };
    await repo.upsertGitHubRun(f.workflow, { ...f.run, admission }, [f.job]);
    await repo.approve(f.org, f.run.id, "admin", admission.key);
    await repo.setRunAdmission(f.org, f.run.id, {
      ...admission,
      state: "blocked",
      reason: "actor_not_allowed",
    });
    await expect(repo.approve(f.org, f.run.id, "admin", admission.key)).rejects.toThrow("changed");
    expect(await repo.reserveRunnerSession(f.session)).toBeUndefined();
  });
  it("checks the actual assigned workflow before starting the worker, not its original demand", async () => {
    const f = await fixture();
    await repo.upsertGitHubRun(f.workflow, f.run, [f.job]);
    await repo.reserveRunnerSession(f.session);
    await repo.claimRunnerSession(f.org, f.session.id, "admit");
    await repo.updateRunnerSession(f.org, f.session.id, "admit", {
      githubRunnerId: "123",
      state: "running",
    });
    const actualWorkflow = await repo.saveWorkflow({
      ...f.workflow,
      id: generateId("wf"),
      path: ".github/workflows/other.yml",
      githubWorkflowId: "2",
    });
    const actualRun = {
      ...f.run,
      id: generateId("run"),
      workflowId: actualWorkflow.id,
      idempotencyKey: "actual-assignment",
      github: { ...f.run.github, id: "43", workflowId: "2" },
      admission: {
        ...f.run.admission,
        workflowVersion: actualWorkflow.updatedAt.toISOString(),
        state: "approval_required" as const,
        reason: "approval_required" as const,
        key: "b".repeat(64),
      },
    };
    const actualJob = {
      ...f.job,
      id: generateId("job"),
      runId: actualRun.id,
      github: { ...f.job.github, id: "51", runnerId: "123", runnerName: f.session.runnerName },
    };
    await repo.upsertGitHubRun(actualWorkflow, actualRun, [actualJob]);
    const decide = (nonce = "c".repeat(64)) =>
      repo.admitRunnerSession(
        f.org,
        f.session.id,
        "admit",
        actualJob.id,
        nonce,
        actualRun.admission.key,
      );
    expect(await decide()).toBe(false);
    await repo.approve(f.org, actualRun.id, "admin", actualRun.admission.key);
    expect(await decide()).toBe(true);
    expect(await decide()).toBe(true); // Lost transport response may retry the same decision.
    expect(await decide("d".repeat(64))).toBe(false);
    expect((await repo.runnerSession(f.org, f.session.id))?.admittedJobId).toBe(actualJob.id);
    await repo.requestGitHubCancel(f.org, actualRun.id);
    expect(await decide()).toBe(false);
  });
  it("rejects fork execution on persistent servers even with approval", async () => {
    const f = await fixture();
    const serverId = generateId("server");
    await connection.db
      .insert(schema.servers)
      .values({ id: serverId, organizationId: f.org, sshHost: "isolated.invalid" });
    const runner = await repo.saveRunner({ ...f.runner, cloudPoolId: null, serverId });
    await repo.upsertGitHubRun(
      f.workflow,
      {
        ...f.run,
        untrusted: true,
        approvedAt: new Date(),
        approvalKey: f.run.admission.key,
        admission: {
          ...f.run.admission,
          runnerKeys: { [runner.id]: actionRunnerAdmissionKey(runner) },
        },
      },
      [f.job],
    );
    expect(await repo.reserveRunnerSession(f.session)).toBeUndefined();
  });
  it("does not let blocked runs fill the runnable queue", async () => {
    const f = await fixture();
    for (let i = 0; i < 52; i++) {
      const id = generateId("run");
      await repo.upsertGitHubRun(
        f.workflow,
        {
          ...f.run,
          id,
          number: i + 100,
          github: { ...f.run.github, id: String(i + 100) },
          idempotencyKey: `blocked-${i}`,
          admission: { ...f.run.admission, state: "blocked", reason: "actor_not_allowed" },
        },
        [
          {
            ...f.job,
            id: generateId("job"),
            runId: id,
            github: { ...f.job.github, id: String(i + 100) },
          },
        ],
      );
    }
    await repo.upsertGitHubRun(f.workflow, f.run, [f.job]);
    expect(await repo.queuedGitHubJobs()).toContainEqual(
      expect.objectContaining({ job: expect.objectContaining({ id: f.job.id }) }),
    );
  });
  it("preserves GitHub workflow features while independent protected environments remain gated", async () => {
    const plan = await parseActionWorkflow(source, ".github/workflows/ci.yml", "github");
    expect(plan.jobs[0]?.uses).toBe("./.github/workflows/shared.yml");
    expect(plan.jobs[1]?.environment).toBe("production");
    await expect(parseActionWorkflow(source)).rejects.toThrow("protected environments");
  });
  it("mirrors native runs without admitting them to the independent scheduler", async () => {
    const f = await fixture();
    await expect(repo.createRun(f.run)).rejects.toThrow();
    await repo.upsertGitHubRun(f.workflow, f.run, [f.job], null);
    expect(await repo.pendingRuns()).not.toContainEqual(expect.objectContaining({ id: f.run.id }));
    expect(await repo.queuedGitHubJobs()).toContainEqual(
      expect.objectContaining({ job: expect.objectContaining({ id: f.job.id }) }),
    );
  });
  it("serializes runner sessions and keeps capacity until verified cleanup", async () => {
    const f = await fixture();
    await repo.upsertGitHubRun(f.workflow, f.run, [f.job]);
    const results = await Promise.all([
      repo.reserveRunnerSession(f.session),
      repo.reserveRunnerSession({
        ...f.session,
        id: generateId("session"),
        runnerName: `openship-${generateId("runner")}`,
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repo.runnerBusy(f.org, f.runner.id)).toBe(true);
    await expect(
      repo.saveRunner({ ...f.runner, config: { ...f.runner.config, cpu: 2 } }),
    ).rejects.toThrow();
    const saved = results.find(Boolean)!;
    await repo.claimRunnerSession(f.org, saved.id, "owner");
    expect(
      await repo.updateRunnerSession("other-org", saved.id, "owner", { cleanedAt: new Date() }),
    ).toBeUndefined();
    await repo.updateRunnerSession(f.org, saved.id, "owner", {
      cleanedAt: new Date(),
      state: "finished",
    });
    expect(await repo.runnerBusy(f.org, f.runner.id)).toBe(false);
  });
  it("replaces a registration that GitHub assigned to another queued job", async () => {
    const f = await fixture();
    const other = {
      ...f.job,
      id: generateId("job"),
      matrixIndex: 1,
      github: { ...f.job.github, id: "51" },
    };
    await repo.upsertGitHubRun(f.workflow, f.run, [f.job, other]);
    expect(await repo.reserveRunnerSession(f.session)).toBeTruthy();
    await repo.claimRunnerSession(f.org, f.session.id, "owner");
    // The label-matched registration ran (and failed) the other job instead.
    await connection.db
      .update(schema.actionRunnerSession)
      .set({ admittedJobId: other.id })
      .where(eq(schema.actionRunnerSession.id, f.session.id));
    await repo.updateRunnerSession(f.org, f.session.id, "owner", {
      state: "finished",
      cleanedAt: new Date(),
      error: "GitHub runner failure; rerun the job after cleanup.",
    });
    const replacement = {
      ...f.session,
      id: generateId("session"),
      runnerName: `openship-${generateId("runner")}`,
    };
    expect(await repo.reserveRunnerSession(replacement)).toBeTruthy();
    // A failure of the job's own registration still needs an explicit rerun.
    await repo.claimRunnerSession(f.org, replacement.id, "owner");
    await repo.updateRunnerSession(f.org, replacement.id, "owner", {
      state: "finished",
      cleanedAt: new Date(),
      error: "GitHub runner failure; rerun the job after cleanup.",
    });
    expect(
      await repo.reserveRunnerSession({
        ...f.session,
        id: generateId("session"),
        runnerName: `openship-${generateId("runner")}`,
      }),
    ).toBeUndefined();
  });
  it("lets a registration whose demand was taken elsewhere serve another queued job", async () => {
    const f = await fixture();
    const runner = await repo.saveRunner({
      ...f.runner,
      config: { ...f.runner.config, maxParallel: 2 },
    });
    const run = {
      ...f.run,
      admission: {
        ...f.run.admission,
        runnerKeys: { [runner.id]: actionRunnerAdmissionKey(runner) },
      },
    };
    const other = {
      ...f.job,
      id: generateId("job"),
      matrixIndex: 1,
      github: { ...f.job.github, id: "51" },
    };
    await repo.upsertGitHubRun(f.workflow, run, [f.job, other]);
    expect(await repo.reserveRunnerSession(f.session)).toBeTruthy();
    const forOther = {
      ...f.session,
      id: generateId("session"),
      demandJobId: other.id,
      runnerName: `openship-${generateId("runner")}`,
    };
    // While both jobs wait, each needs its own registration.
    await connection.db
      .update(schema.actionRunnerSession)
      .set({ state: "listening" })
      .where(eq(schema.actionRunnerSession.id, f.session.id));
    expect(await repo.reserveRunnerSession(forOther)).toBeTruthy();
    await connection.db
      .delete(schema.actionRunnerSession)
      .where(eq(schema.actionRunnerSession.id, forOther.id));
    // Another registration picked up the first job, so its own is now spare.
    await connection.db
      .update(schema.actionJob)
      .set({ status: "running" })
      .where(eq(schema.actionJob.id, f.job.id));
    expect(
      await repo.reserveRunnerSession({ ...forOther, id: generateId("session") }),
    ).toBeUndefined();
  });
  it.each(["unlisted", "stale approval", "unsupported job", "eligible"] as const)(
    "uses only eligible spare registrations (%s)",
    async (kind) => {
      const f = await fixture();
      const spareRunner = await repo.saveRunner({
        ...f.runner,
        id: generateId("runner"),
        name: "spare",
        cloudPoolId: generateId("pool"),
        config: {
          ...f.runner.config,
          mode: kind === "unsupported job" ? "native" : f.runner.config.mode,
        },
      });
      const workflow = await repo.saveWorkflow({
        ...f.workflow,
        runnerIds: kind === "unlisted" ? [f.runner.id] : [f.runner.id, spareRunner.id],
      });
      const runnerKeys = { ...f.run.admission.runnerKeys };
      if (kind !== "unlisted") {
        runnerKeys[spareRunner.id] =
          kind === "stale approval" ? "b".repeat(64) : actionRunnerAdmissionKey(spareRunner);
      }
      const run = {
        ...f.run,
        admission: {
          ...f.run.admission,
          workflowVersion: workflow.updatedAt.toISOString(),
          runnerIds: workflow.runnerIds,
          runnerKeys,
        },
        configuration: { ...f.run.configuration, runnerIds: workflow.runnerIds },
      };
      const job = {
        ...f.job,
        spec: { ...f.job.spec, requiresDocker: kind === "unsupported job" },
      };
      const session = { ...f.session, spec: job.spec };
      await repo.upsertGitHubRun(workflow, run, [job]);
      expect(await repo.reserveRunnerSession(session)).toBeTruthy();
      await connection.db
        .delete(schema.actionRunnerSession)
        .where(eq(schema.actionRunnerSession.id, session.id));

      const spareWorkflow = await repo.saveWorkflow({
        ...f.workflow,
        id: generateId("wf"),
        githubWorkflowId: "2",
        path: ".github/workflows/other.yml",
        runnerIds: [spareRunner.id],
      });
      const spareRun = {
        ...f.run,
        id: generateId("run"),
        workflowId: spareWorkflow.id,
        idempotencyKey: "spare-run",
        github: { ...f.run.github, id: "43", workflowId: "2" },
        admission: {
          ...f.run.admission,
          workflowVersion: spareWorkflow.updatedAt.toISOString(),
          runnerIds: [spareRunner.id],
          runnerKeys: { [spareRunner.id]: actionRunnerAdmissionKey(spareRunner) },
        },
        configuration: { ...f.run.configuration, runnerIds: [spareRunner.id] },
      };
      const spareJob = {
        ...f.job,
        id: generateId("job"),
        runId: spareRun.id,
        github: { ...f.job.github, id: "51" },
      };
      await repo.upsertGitHubRun(spareWorkflow, spareRun, [spareJob]);
      const spare = {
        ...f.session,
        id: generateId("session"),
        workflowId: spareWorkflow.id,
        runnerId: spareRunner.id,
        demandJobId: spareJob.id,
        runnerName: `openship-${generateId("runner")}`,
      };
      expect(await repo.reserveRunnerSession(spare)).toBeTruthy();
      await connection.db
        .update(schema.actionRunnerSession)
        .set({ state: "listening" })
        .where(eq(schema.actionRunnerSession.id, spare.id));
      await connection.db
        .update(schema.actionJob)
        .set({ status: "running" })
        .where(eq(schema.actionJob.id, spareJob.id));

      const reserved = await repo.reserveRunnerSession(session);
      if (kind === "eligible") expect(reserved).toBeUndefined();
      else expect(reserved).toBeTruthy();
    },
  );
  it("does not overwrite a newer mirror with a stale job response", async () => {
    const f = await fixture();
    const first = await repo.upsertGitHubRun(f.workflow, f.run, [f.job], null);
    await repo.upsertGitHubRun(
      f.workflow,
      {
        ...f.run,
        status: "success",
        finishedAt: new Date(),
        settledAt: new Date(),
        github: {
          ...f.run.github,
          status: "completed",
          conclusion: "success",
          updatedAt: "2026-10-10T00:01:00Z",
        },
      },
      [{ ...f.job, status: "success", finishedAt: new Date() }],
      first.updatedAt,
    );
    await repo.upsertGitHubRun(
      f.workflow,
      f.run,
      [{ ...f.job, status: "queued" }],
      first.updatedAt,
    );
    expect((await repo.run(f.org, f.run.id))?.status).toBe("success");
    expect((await repo.job(f.org, f.job.id))?.status).toBe("success");
  });
  it("keeps GitHub job cleanup pending until the allocated runner is removed", async () => {
    const f = await fixture();
    await repo.upsertGitHubRun(f.workflow, f.run, [f.job]);
    await repo.reserveRunnerSession(f.session);
    const finishedAt = new Date();
    const job = { ...f.job, status: "success" as const, finishedAt, cleanedAt: finishedAt };
    await repo.upsertGitHubRun(f.workflow, f.run, [job]);
    expect((await repo.job(f.org, job.id))?.cleanedAt).toBeNull();
    expect(await repo.gitHubRunHasAllocations(f.org, f.run.id)).toBe(true);
    await repo.claimRunnerSession(f.org, f.session.id, "cleanup");
    const cleanedAt = new Date(finishedAt.getTime() + 1_000);
    await repo.updateRunnerSession(f.org, f.session.id, "cleanup", {
      cleanedAt,
      state: "finished",
    });
    await repo.upsertGitHubRun(f.workflow, f.run, [job]);
    expect((await repo.job(f.org, job.id))?.cleanedAt).toEqual(cleanedAt);
    expect(await repo.gitHubRunHasAllocations(f.org, f.run.id)).toBe(false);
  });
  it("shares admission limits between independent jobs and GitHub registrations", async () => {
    const f = await fixture();
    await repo.upsertGitHubRun(f.workflow, f.run, [f.job]);
    const independent = await repo.saveWorkflow({
      ...f.workflow,
      id: generateId("wf"),
      controller: "openship",
      githubWorkflowId: null,
      accessPolicy: null,
      path: ".openship/workflows/ci.yml",
      source,
    });
    const run = await repo.createRun({
      ...f.run,
      id: generateId("run"),
      workflowId: independent.id,
      controller: "openship",
      github: null,
      idempotencyKey: "independent",
    });
    const id = generateId("job");
    await connection.db
      .insert(schema.actionJob)
      .values({ ...f.job, id, runId: run.id, github: null });
    await repo.claimRun(f.org, run.id, "independent-controller");
    const results = await Promise.all([
      repo.reserveRunner(f.org, id, f.runner.id, "independent-controller"),
      repo.reserveRunnerSession(f.session),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("keeps disabled workflows reconcilable until their existing runs settle", async () => {
    const f = await fixture();
    await repo.upsertGitHubRun(f.workflow, f.run, [f.job]);
    await repo.disableWorkflow(f.org, f.workflow.id);
    expect(await repo.pendingGitHubWorkflows(new Date(Date.now() + 1_000))).toContainEqual(
      expect.objectContaining({ id: f.workflow.id }),
    );
    await repo.claimRun(f.org, f.run.id, "completion");
    await repo.updateRun(f.org, f.run.id, "completion", {
      status: "success",
      settledAt: new Date(),
      finishedAt: new Date(),
    });
    expect(await repo.pendingGitHubWorkflows(new Date(Date.now() + 1_000))).not.toContainEqual(
      expect.objectContaining({ id: f.workflow.id }),
    );
  });
  it("attaches a late accepted Jobs receipt without replacing the original run authority", async () => {
    const f = await fixture();
    const first = await repo.upsertGitHubRun(f.workflow, f.run, [f.job]);
    const sourceJob = { key: "scheduled", label: "Nightly CI", trigger: "schedule" };
    const saved = await repo.upsertGitHubRun(
      f.workflow,
      {
        ...f.run,
        authority: { ...f.run.authority, userId: "different" },
        configuration: { ...f.run.configuration, sourceJob },
      },
      [f.job],
      first.updatedAt,
    );
    expect(saved.configuration.sourceJob).toEqual(sourceJob);
    expect(saved.authority).toEqual(f.run.authority);
  });
  it("persists command intent once and rejects conflicting request replays", async () => {
    const f = await fixture();
    const command = {
      id: generateId("cmd"),
      organizationId: f.org,
      workflowId: f.workflow.id,
      idempotencyKey: "one-click",
      requestHash: "same-request",
    };
    const results = await Promise.all([
      repo.beginGitHubCommand(command),
      repo.beginGitHubCommand({ ...command, id: generateId("cmd") }),
    ]);
    expect(results.filter((row) => row.submit)).toHaveLength(1);
    await repo.finishGitHubCommand(f.org, results[0]!.command.id, {
      state: "accepted",
      remoteRunId: "42",
      remoteAttempt: 1,
      error: null,
    });
    const retry = await repo.beginGitHubCommand({ ...command, id: generateId("cmd") });
    expect(retry.submit).toBe(false);
    expect(retry.command.state).toBe("accepted");
    await expect(
      repo.beginGitHubCommand({ ...command, id: generateId("cmd"), requestHash: "other-request" }),
    ).rejects.toThrow("different workflow command");
  });
});
