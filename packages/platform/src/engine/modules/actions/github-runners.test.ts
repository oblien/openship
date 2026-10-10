import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  createRepositories,
  schema,
  type DatabaseConnection,
} from "@repo/db/factory";
import { eq } from "drizzle-orm";
import { generateId } from "@repo/core";

const state = vi.hoisted(() => ({
  repo: null as any,
  organizationId: "",
  open: vi.fn(),
  remove: vi.fn(),
  registrations: vi.fn(),
  deregister: vi.fn(),
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
vi.mock("./access", () => ({ authorizeActionWorkflow: async () => {} }));
vi.mock("../../lib/encryption", () => ({
  encrypt: (value: string) => value,
  decrypt: (value: string) => value,
}));
vi.mock("./worker-execution", () => ({
  openActionWorker: state.open,
  removeActionWorker: state.remove,
}));
vi.mock("./github-api", () => ({
  GitHubActionsApi: class {
    runners = state.registrations;
    removeRunner = state.deregister;
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
  state.registrations.mockResolvedValue([]);
  state.remove.mockResolvedValue(true);
  state.deregister.mockResolvedValue({ success: true });
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
  return { org, id, runner, workflow, runId, get: () => repo.runnerSession(org, id) };
}
describe("official GitHub runner reconciliation", () => {
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
  it("removes paid runtime even after credentials are revoked, then reconciles registration", async () => {
    const f = await fixture(false);
    state.registrations.mockRejectedValueOnce(new Error("GitHub credential revoked"));
    await reconcileGitHubRunners();
    expect(state.remove).toHaveBeenCalledOnce();
    expect(state.open).not.toHaveBeenCalled();
    expect((await f.get())?.finishedAt).toBeTruthy();
    await reconcileGitHubRunners();
    expect((await f.get())?.cleanedAt).toBeTruthy();
    expect(state.open).not.toHaveBeenCalled();
  });
});
