import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRepositories,
  schema,
  type DatabaseConnection,
} from "@repo/db/factory";
import { generateId } from "@repo/core";
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
  it("preserves reusable calls, protected environments and OIDC only for GitHub", async () => {
    const plan = await parseActionWorkflow(source, ".github/workflows/ci.yml", "github");
    expect(plan.jobs[0]?.uses).toBe("./.github/workflows/shared.yml");
    expect(plan.jobs[1]?.environment).toBe("production");
    await expect(parseActionWorkflow(source)).rejects.toThrow("reusable workflows");
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
    const job = { ...f.job, status: "success", finishedAt, cleanedAt: finishedAt };
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
