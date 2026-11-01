import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  createRepositories,
  schema,
  eq,
  type DatabaseConnection,
} from "@repo/db/factory";
import { AppError, generateId, actionRunnerAdmissionKey } from "@repo/core";

const state = vi.hoisted(() => ({
  repo: null as any,
  organizationId: "",
  open: vi.fn(),
  remove: vi.fn(),
  registrations: vi.fn(),
  deregister: vi.fn(),
  run: vi.fn(),
  synchronize: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    get actions() {
      return state.repo;
    },
  },
}));
vi.mock("../../lib/execution-authority", () => ({
  resolveExecutionAuthority: async (value: unknown) => value,
}));
vi.mock("./access", () => ({ authorizeActionWorkflow: state.authorize }));
vi.mock("../../lib/encryption", () => ({
  encrypt: (value: string) => value,
  decrypt: (value: string) => value,
}));
vi.mock("../github/github.auth", () => ({ getUserStatus: vi.fn() }));
vi.mock("./github-sync", () => ({ synchronizeGitHubRun: state.synchronize }));
vi.mock("./worker-execution", () => ({
  openActionWorker: state.open,
  removeActionWorker: state.remove,
}));
vi.mock("./github-api", () => ({
  GitHubActionsApi: class {
    runners = state.registrations;
    removeRunner = state.deregister;
    run = state.run;
  },
}));
import { reconcileGitHubRunners, requestsOpenshipRunner } from "./github-runners";
let connection: DatabaseConnection;
let repo: ReturnType<typeof createRepositories>["actions"];
beforeAll(async () => {
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  repo = createRepositories(connection.db, {
    encrypt: (value) => value,
    decrypt: (value) => value,
  }).actions;
  state.repo = {
    ...repo,
    runnerSessions: async () => await repo.runnerSessions(state.organizationId),
    queuedGitHubJobs: async () =>
      (await repo.queuedGitHubJobs()).filter(
        (row) => row.workflow.organizationId === state.organizationId,
      ),
  };
}, 60000);
afterAll(async () => {
  await connection?.close();
});
beforeEach(() => {
  vi.clearAllMocks();
  state.run.mockReset();
  state.synchronize.mockReset();
  state.registrations.mockResolvedValue([]);
  state.remove.mockResolvedValue(true);
  state.deregister.mockResolvedValue({ success: true });
  state.authorize.mockResolvedValue(undefined);
});
async function fixture(finished = true) {
  const org = (state.organizationId = generateId("org"));
  await connection.db.insert(schema.organization).values({ id: org, name: "Isolated" });
  const runner = await repo.saveRunner({
    id: generateId("runner"),
    organizationId: org,
    name: "Temporary",
    cloudPoolId: generateId("pool"),
    config: {
      mode: "container",
      image: "node:22",
      labels: [],
      maxParallel: 1,
      cpu: 1,
      memoryMb: 1024,
      allowDockerSocket: true,
    },
    capabilities: {
      os: "linux",
      architecture: "x64",
      docker: true,
      git: true,
      node: true,
      distribution: "ubuntu",
      version: "22.04",
    },
  });
  const authority = {
    version: 1 as const,
    userId: "owner",
    organizationId: org,
    token: null,
    restrictions: null,
  };
  const definition = { name: "CI", triggers: { push: {} }, jobs: [] };
  const workflow = await repo.saveWorkflow({
    id: generateId("wf"),
    organizationId: org,
    name: "CI",
    controller: "github",
    githubWorkflowId: "1",
    owner: "owner",
    repo: "test",
    path: ".github/workflows/ci.yml",
    ref: "main",
    source: null,
    definition,
    runnerIds: [runner.id],
    authority,
    accessPolicy: {
      version: 1,
      audience: "owner",
      owner: { provider: "github", id: "42", login: "owner" },
      users: [],
      approval: "automatic",
      forks: "deny",
    },
  });
  const runId = generateId("run"),
    jobId = generateId("job");
  const spec = {
    jobId: "build",
    name: "Build",
    labels: ["self-hosted", "openship", "linux"],
    matrix: {},
    strategy: {},
    needs: {},
    timeoutSeconds: 60,
    continueOnError: false,
    failFast: false,
    maxParallel: 1,
    concurrency: null,
    permissions: {},
    requiresDocker: false,
  };
  await repo.upsertGitHubRun(
    workflow,
    {
      id: runId,
      organizationId: org,
      workflowId: workflow.id,
      controller: "github",
      number: 1,
      attempt: 1,
      idempotencyKey: runId,
      admission: {
        state: "allowed",
        reason: "allowed",
        key: "a".repeat(64),
        workflowVersion: workflow.updatedAt.toISOString(),
        runnerIds: [runner.id],
        runnerKeys: { [runner.id]: actionRunnerAdmissionKey(runner) },
      },
      source: "on: push",
      plan: definition,
      authority,
      configuration: {
        owner: "owner",
        repo: "test",
        path: workflow.path,
        defaultBranch: "main",
        runnerIds: [runner.id],
        variables: {},
        secrets: {},
      },
      revision: "a".repeat(40),
      ref: "refs/heads/main",
      eventName: "push",
      event: {},
      actor: "owner",
      github: {
        id: "1",
        workflowId: "1",
        url: "https://github.com/owner/test/actions/runs/1",
        status: "queued",
        conclusion: null,
        updatedAt: new Date().toISOString(),
      },
    },
    [
      {
        id: jobId,
        organizationId: org,
        runId,
        jobKey: "build",
        matrixIndex: 0,
        spec,
        github: {
          id: "2",
          url: "https://github.com/owner/test/actions/runs/1/job/2",
          runnerId: null,
          runnerName: null,
          steps: [],
        },
      },
    ],
  );
  const id = generateId("session");
  await repo.reserveRunnerSession({
    id,
    organizationId: org,
    workflowId: workflow.id,
    runnerId: runner.id,
    demandJobId: jobId,
    repoOwner: "owner",
    repoName: "test",
    runnerName: `openship-${id}`,
    spec,
  });
  await repo.claimRunnerSession(org, id, "fixture");
  await repo.updateRunnerSession(org, id, "fixture", {
    state: finished ? "stopping" : "running",
    workerStartedAt: new Date(),
    finishedAt: finished ? new Date() : null,
    providerWorkspaceId: "vm-owned",
    providerRequestedAt: new Date(),
    workerBinary: "/worker",
    directory: "/jobs/owned",
  });
  await repo.releaseRunnerSession(org, id, "fixture");
  await connection.db
    .update(schema.actionJob)
    .set({ status: "success", finishedAt: new Date() })
    .where(eq(schema.actionJob.id, jobId));
  return { org, id, runner, workflow, runId, jobId, get: () => repo.runnerSession(org, id) };
}
async function assignmentFixture() {
  const f = await fixture(false);
  const request = {
    id: "c".repeat(64),
    repository: "owner/test",
    repositoryId: "10",
    runId: "1",
    attempt: 1,
  };
  const remote = {
    id: 1,
    repository: { id: 10 },
    run_attempt: 1,
    workflow_id: 1,
    status: "in_progress",
  };
  await repo.claimRunnerSession(f.org, f.id, "fixture");
  await repo.updateRunnerSession(f.org, f.id, "fixture", { githubRunnerId: "777" });
  await repo.releaseRunnerSession(f.org, f.id, "fixture");
  const job = (await repo.job(f.org, f.jobId))!;
  await connection.db
    .update(schema.actionJob)
    .set({
      status: "running",
      finishedAt: null,
      github: { ...job.github!, runnerId: "777", runnerName: `openship-${f.id}` },
    })
    .where(eq(schema.actionJob.id, f.jobId));
  state.registrations.mockResolvedValue([{ id: 777, name: `openship-${f.id}`, busy: true }]);
  state.run.mockResolvedValue(remote);
  state.synchronize.mockImplementation(() => repo.run(f.org, f.runId));
  const admit = vi.fn(),
    release = vi.fn();
  state.open.mockResolvedValue({
    binary: "/worker",
    directory: "/jobs/owned",
    release,
    worker: {
      inspect: async () => ({
        state: "running",
        events: [],
        hasMore: false,
        githubAdmission: request,
      }),
      admitGitHub: admit,
    },
  });
  return { ...f, request, remote, admit, release };
}
describe("official GitHub runner reconciliation", () => {
  it.each([true, false])(
    "continues an authorized stop through a GitHub outage without replacing the result (completed: %s)",
    async (completed) => {
      const f = await fixture(completed);
      if (!completed) {
        await repo.claimRunnerSession(f.org, f.id, "fixture");
        await repo.updateRunnerSession(f.org, f.id, "fixture", { cancelRequestedAt: new Date() });
        await repo.releaseRunnerSession(f.org, f.id, "fixture");
      }
      state.registrations.mockRejectedValueOnce(
        Object.assign(new Error("GitHub unavailable"), { status: 503 }),
      );
      await reconcileGitHubRunners();
      expect(state.remove).toHaveBeenCalledOnce();
      expect(await f.get()).toMatchObject({ state: "stopping", error: null });
      await reconcileGitHubRunners();
      expect((await f.get())?.cleanedAt).toBeTruthy();
      expect((await f.get())?.error).toBeNull();
      expect(state.open).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])(
    "retains a terminal infrastructure error during GitHub sync only for the actual assigned runner (%s)",
    async (matchingRunner) => {
      const f = await assignmentFixture();
      await reconcileGitHubRunners();
      await repo.claimRunnerSession(f.org, f.id, "fixture");
      await repo.updateRunnerSession(f.org, f.id, "fixture", {
        state: "stopping",
        finishedAt: new Date(),
        error: "The worker stopped before confirming completion",
      });
      await repo.releaseRunnerSession(f.org, f.id, "fixture");
      const run = (await repo.run(f.org, f.runId))!;
      const job = (await repo.job(f.org, f.jobId))!;
      for (let attempt = 0; attempt < 2; attempt++) {
        await repo.upsertGitHubRun(f.workflow, run, [
          {
            ...job,
            status: "failure",
            finishedAt: new Date(),
            error: null,
            github: {
              ...job.github!,
              runnerName: matchingRunner ? `openship-${f.id}` : "another-runner",
            },
          },
        ]);
        expect((await repo.job(f.org, f.jobId))?.error).toBe(
          matchingRunner ? "The worker stopped before confirming completion" : null,
        );
      }
    },
  );

  it.each(["provider", "inspect", "github", "authorization"])(
    "keeps a running worker and its capacity through a temporary %s observation failure",
    async (stage) => {
      const f = await assignmentFixture();
      await reconcileGitHubRunners();
      const inspect = vi.fn().mockResolvedValue({ state: "running", events: [], hasMore: false });
      const release = vi.fn();
      state.open.mockResolvedValue({
        binary: "/worker",
        directory: "/jobs/owned",
        release,
        worker: { inspect },
      });
      const unavailable = Object.assign(new Error("Provider temporarily unavailable"), {
        status: 503,
      });
      if (stage === "provider") state.open.mockRejectedValueOnce(unavailable);
      if (stage === "inspect")
        inspect.mockRejectedValueOnce(
          new TypeError("fetch failed", {
            cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
          }),
        );
      if (stage === "github")
        state.registrations.mockRejectedValueOnce(
          Object.assign(new Error("rate limited"), { status: 403, credentialRejected: false }),
        );
      if (stage === "authorization") state.authorize.mockRejectedValueOnce(unavailable);
      await reconcileGitHubRunners();
      expect(await f.get()).toMatchObject({
        state: "running",
        finishedAt: null,
        cleanedAt: null,
        error: null,
        admittedJobId: f.jobId,
      });
      expect(state.remove).not.toHaveBeenCalled();
      expect(state.deregister).not.toHaveBeenCalled();
      expect(await repo.runnerBusy(f.org, f.runner.id)).toBe(true);
      await reconcileGitHubRunners();
      expect(inspect).toHaveBeenCalled();
      expect((await f.get())?.state).toBe("running");
      expect(state.remove).not.toHaveBeenCalled();
    },
  );

  it.each([null, "Worker exited before confirming the job result"])(
    "persists the worker result before busy registration cleanup without replacing its error (%s)",
    async (error) => {
      const f = await fixture(false);
      state.registrations.mockResolvedValue([{ id: 10, name: `openship-${f.id}`, busy: false }]);
      state.deregister.mockRejectedValueOnce({ status: 422 });
      state.open.mockResolvedValue({
        binary: "/worker",
        directory: "/jobs/owned",
        release: async () => {},
        worker: {
          inspect: async () => ({
            state: "finished",
            events: [],
            hasMore: false,
            result: { conclusion: error ? "failure" : "success", error },
          }),
        },
      });
      await reconcileGitHubRunners();
      expect(await f.get()).toMatchObject({ state: "stopping", error, cleanedAt: null });
      expect((await f.get())?.finishedAt).toBeTruthy();
      await reconcileGitHubRunners();
      expect(await f.get()).toMatchObject({ state: "finished", error });
      expect((await f.get())?.cleanedAt).toBeTruthy();
      expect(state.open).toHaveBeenCalledOnce();
    },
  );

  it("waits for GitHub's assigned runner metadata and durably admits only that assignment", async () => {
    const f = await assignmentFixture();
    const job = (await repo.job(f.org, f.jobId))!;
    await connection.db
      .update(schema.actionJob)
      .set({ github: { ...job.github!, runnerId: null, runnerName: null } })
      .where(eq(schema.actionJob.id, f.jobId));
    await reconcileGitHubRunners();
    expect(f.admit).not.toHaveBeenCalled();
    expect((await f.get())?.admissionId).toBeNull();
    expect(f.release).toHaveBeenCalledOnce();

    await connection.db
      .update(schema.actionJob)
      .set({ github: job.github })
      .where(eq(schema.actionJob.id, f.jobId));
    await reconcileGitHubRunners();
    expect(f.admit).toHaveBeenLastCalledWith("/worker", "/jobs/owned", f.request.id, true);
    expect(await f.get()).toMatchObject({ admissionId: f.request.id, admittedJobId: f.jobId });
    await reconcileGitHubRunners(); // A lost response retries the durable decision.
    expect(f.admit).toHaveBeenLastCalledWith("/worker", "/jobs/owned", f.request.id, true);
    expect(state.run).toHaveBeenCalledTimes(2);
    await repo.requestGitHubCancel(f.org, f.runId);
    await reconcileGitHubRunners();
    expect(f.admit).toHaveBeenLastCalledWith("/worker", "/jobs/owned", f.request.id, false);
    expect((await f.get())?.state).toBe("stopping");
  });

  it.each(["repository", "repositoryId", "attempt", "workflow", "completed", "nonce"])(
    "denies a mismatched %s before starting workflow code",
    async (mismatch) => {
      const f = await assignmentFixture();
      if (mismatch === "repository") f.request.repository = "other/repository";
      if (mismatch === "repositoryId") f.remote.repository.id = 99;
      if (mismatch === "attempt") f.remote.run_attempt = 2;
      if (mismatch === "workflow") f.remote.workflow_id = 99;
      if (mismatch === "completed") f.remote.status = "completed";
      if (mismatch === "nonce") f.request.id = "invalid";
      await reconcileGitHubRunners();
      expect(f.admit).toHaveBeenCalledExactlyOnceWith(
        "/worker",
        "/jobs/owned",
        f.request.id,
        false,
      );
      expect(await f.get()).toMatchObject({ state: "stopping", admittedJobId: null });
    },
  );

  it.each([true, false])(
    "evaluates the actual workflow when GitHub assigns another matching job (approved: %s)",
    async (approved) => {
      const f = await assignmentFixture();
      const workflow = await repo.saveWorkflow({
        ...f.workflow,
        id: generateId("wf"),
        path: ".github/workflows/other.yml",
        githubWorkflowId: "2",
      });
      const original = (await repo.run(f.org, f.runId))!;
      const run = {
        ...original,
        id: generateId("run"),
        workflowId: workflow.id,
        idempotencyKey: "other-assignment",
        number: 2,
        github: { ...original.github!, id: "43", workflowId: "2" },
        admission: {
          ...original.admission!,
          workflowVersion: workflow.updatedAt.toISOString(),
          key: "b".repeat(64),
          state: approved ? ("allowed" as const) : ("approval_required" as const),
          reason: approved ? ("allowed" as const) : ("approval_required" as const),
        },
      };
      const originalJob = (await repo.job(f.org, f.jobId))!;
      const job = {
        ...originalJob,
        id: generateId("job"),
        runId: run.id,
        github: { ...originalJob.github!, id: "44" },
      };
      await repo.upsertGitHubRun(workflow, run, [job]);
      await connection.db
        .update(schema.actionJob)
        .set({ status: "success", finishedAt: new Date() })
        .where(eq(schema.actionJob.id, f.jobId));
      f.request.runId = "43";
      f.remote.id = 43;
      f.remote.workflow_id = 2;
      state.synchronize.mockImplementation(() => repo.run(f.org, run.id));
      await reconcileGitHubRunners();
      expect(state.synchronize).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: workflow.id }),
        f.remote,
        expect.anything(),
      );
      expect(f.admit).toHaveBeenCalledExactlyOnceWith(
        "/worker",
        "/jobs/owned",
        f.request.id,
        approved,
      );
      expect((await f.get())?.admittedJobId).toBe(approved ? job.id : null);
    },
  );

  it("rejects revoked access even after the registration has accepted a job", async () => {
    const f = await assignmentFixture();
    const run = (await repo.run(f.org, f.runId))!;
    await repo.setRunAdmission(f.org, run.id, {
      ...run.admission!,
      state: "blocked",
      reason: "actor_not_allowed",
    });
    await reconcileGitHubRunners();
    expect(f.admit).toHaveBeenCalledExactlyOnceWith("/worker", "/jobs/owned", f.request.id, false);
    expect((await f.get())?.admittedJobId).toBeNull();
  });

  it("allocates only explicitly opted-in labels", () => {
    expect(requestsOpenshipRunner(["ubuntu-latest"])).toBe(false);
    expect(requestsOpenshipRunner(["self-hosted", "linux"])).toBe(false);
    expect(requestsOpenshipRunner(["SELF-HOSTED", "Openship", "linux"])).toBe(true);
  });
  it("resumes asynchronous VM deletion without reconnecting or releasing capacity early", async () => {
    const f = await fixture();
    state.remove.mockResolvedValueOnce(false).mockResolvedValue(true);
    await reconcileGitHubRunners();
    expect(state.open).not.toHaveBeenCalled();
    expect(await repo.runnerBusy(f.org, f.runner.id)).toBe(true);
    expect(await repo.gitHubRunHasAllocations(f.org, f.runId)).toBe(true);
    await reconcileGitHubRunners();
    expect(state.open).not.toHaveBeenCalled();
    expect((await f.get())?.state).toBe("finished");
    expect(await repo.runnerBusy(f.org, f.runner.id)).toBe(false);
    expect(await repo.gitHubRunHasAllocations(f.org, f.runId)).toBe(false);
  });
  it("persists supervisor completion before retrying deletion", async () => {
    const f = await fixture(false);
    const release = vi.fn();
    state.open.mockResolvedValue({
      binary: "/worker",
      directory: "/jobs/owned",
      release,
      worker: {
        inspect: async () => ({
          state: "finished",
          events: [],
          hasMore: false,
          result: { conclusion: "success" },
        }),
      },
    });
    state.remove.mockResolvedValueOnce(false).mockResolvedValue(true);
    await reconcileGitHubRunners();
    expect((await f.get())?.finishedAt).toBeTruthy();
    expect((await f.get())?.cleanedAt).toBeNull();
    await reconcileGitHubRunners();
    expect(state.open).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect((await f.get())?.cleanedAt).toBeTruthy();
  });
  it("lets an ephemeral runner finish shutting down after GitHub deregisters it", async () => {
    const f = await fixture(false);
    const cancel = vi.fn();
    state.open.mockResolvedValue({
      binary: "/worker",
      directory: "/jobs/owned",
      release: async () => {},
      worker: { inspect: async () => ({ state: "running", events: [], hasMore: false }), cancel },
    });
    await reconcileGitHubRunners();
    expect(cancel).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
    expect((await f.get())?.state).toBe("running");
  });
  it("treats an already removed GitHub registration as completed cleanup", async () => {
    const f = await fixture();
    state.registrations.mockResolvedValue([{ id: 10, name: `openship-${f.id}`, busy: false }]);
    state.deregister.mockRejectedValue({ status: 404 });
    await reconcileGitHubRunners();
    expect((await f.get())?.cleanedAt).toBeTruthy();
    expect((await f.get())?.error).toBeNull();
  });
  it("does not retry a confirmed worker identity mismatch as an ordinary provider outage", async () => {
    const f = await fixture(false);
    state.open.mockRejectedValueOnce(
      new AppError("Cloud returned a different worker", 502, "ACTIONS_WORKER_IDENTITY_MISMATCH"),
    );
    await reconcileGitHubRunners();
    expect(state.remove).toHaveBeenCalledOnce();
    expect(await f.get()).toMatchObject({
      state: "stopping",
      error: "Cloud returned a different worker",
    });
    expect((await f.get())?.finishedAt).toBeTruthy();
  });
  it("removes paid runtime even after credentials are revoked, then reconciles registration", async () => {
    const f = await fixture(false);
    state.registrations.mockRejectedValueOnce(
      Object.assign(new Error("GitHub credential revoked"), {
        status: 401,
        credentialRejected: true,
      }),
    );
    await reconcileGitHubRunners();
    expect(state.remove).toHaveBeenCalledOnce();
    expect(state.open).not.toHaveBeenCalled();
    expect((await f.get())?.finishedAt).toBeTruthy();
    await reconcileGitHubRunners();
    expect((await f.get())?.cleanedAt).toBeTruthy();
    expect(state.open).not.toHaveBeenCalled();
  });
});
