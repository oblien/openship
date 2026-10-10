import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  createRepositories,
  schema,
  type DatabaseConnection,
} from "@repo/db/factory";
import { generateId } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import type { GitHubActionsApi, GitHubWorkflowRun } from "./github-api";
const h = vi.hoisted(() => ({ repo: null as any, source: vi.fn(), completed: vi.fn() }));
vi.mock("@repo/db", async () => ({
  ...(await vi.importActual("@repo/db/factory")),
  githubActionRunId: (org: string, id: string, attempt: number) => `${org}-${id}-${attempt}`,
  githubActionJobId: (org: string, id: string) => `${org}-job-${id}`,
  repos: {
    get actions() {
      return h.repo;
    },
  },
}));
vi.mock("../github/github.service", () => ({ getFileContent: h.source }));
vi.mock("./github-api", () => ({ GitHubActionsApi: class {} }));
vi.mock("./access", () => ({ authorizeActionWorkflow: async () => {} }));
vi.mock("../../lib/execution-authority", () => ({ resolveExecutionAuthority: vi.fn() }));
vi.mock("../jobs/job-workflow", () => ({ workflowJobCompleted: h.completed }));
import { synchronizeGitHubRun, resolveGitHubRunRef } from "./github-sync";
let connection: DatabaseConnection;
beforeAll(async () => {
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  h.repo = createRepositories(connection.db, { encrypt: (v) => v, decrypt: (v) => v }).actions;
}, 60000);
afterAll(async () => {
  await connection?.close();
});
beforeEach(() => {
  vi.clearAllMocks();
  h.completed.mockResolvedValue(undefined);
});
async function fixture() {
  const org = generateId("org");
  await connection.db.insert(schema.organization).values({ id: org, name: org });
  const source =
    "name: CI\non: workflow_dispatch\njobs:\n  build:\n    runs-on: [self-hosted, openship, macos]\n    steps:\n      - if: runner.os == 'Linux'\n        uses: docker://alpine:3.22\n      - run: echo test\n";
  h.source.mockResolvedValue({ content: source });
  const workflow = await h.repo.saveWorkflow({
    id: generateId("wf"),
    organizationId: org,
    controller: "github",
    githubWorkflowId: "1",
    owner: "owner",
    repo: "test",
    name: "CI",
    path: ".github/workflows/ci.yml",
    ref: "main",
    source: null,
    definition: { name: "CI", triggers: { workflow_dispatch: {} }, jobs: [] },
    runnerIds: [],
    authority: {
      version: 1,
      userId: "owner",
      organizationId: org,
      token: null,
      restrictions: null,
    },
  });
  const now = new Date().toISOString();
  const remote: GitHubWorkflowRun = {
    id: 10,
    workflow_id: 1,
    run_number: 1,
    run_attempt: 1,
    head_sha: "a".repeat(40),
    head_branch: "main",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    path: workflow.path,
    html_url: "https://github.com/owner/test/actions/runs/10",
    created_at: now,
    updated_at: now,
    run_started_at: now,
    actor: { login: "owner" },
    repository: { id: 1, full_name: "owner/test", default_branch: "main" },
    head_repository: { id: 1, full_name: "owner/test" },
  };
  const jobs = vi
    .fn()
    .mockResolvedValue([
      {
        id: 20,
        run_id: 10,
        run_attempt: 1,
        name: "build",
        status: "completed",
        conclusion: "success",
        head_sha: remote.head_sha,
        html_url: "https://github.com/owner/test/actions/runs/10/job/20",
        check_run_url: "https://api.github.com/repos/owner/test/check-runs/30",
        started_at: now,
        completed_at: now,
        runner_id: 40,
        runner_name: "openship-worker",
        labels: ["self-hosted", "openship", "macos"],
        steps: [
          {
            number: 1,
            name: "Conditional Docker action",
            status: "completed",
            conclusion: "skipped",
          },
        ],
      },
    ]);
  const api = {
    jobs,
    matchingRefs: vi.fn().mockResolvedValue(["refs/heads/main"]),
  } as unknown as GitHubActionsApi;
  return { org, workflow, remote, api, jobs, ctx: { organizationId: org } as ExecutionContext };
}
describe("authoritative GitHub results", () => {
  it("mirrors the real Check ID and leaves conditional execution to GitHub", async () => {
    const f = await fixture();
    const run = await synchronizeGitHubRun(f.ctx, f.workflow, f.remote, f.api);
    const [job] = await h.repo.jobs(f.org, run.id);
    expect(run.status).toBe("success");
    expect(run.settledAt).toBeTruthy();
    expect(job.checkRunId).toBe("30");
    expect(job.spec.requiresDocker).toBe(false);
    expect(job.github.steps[0].conclusion).toBe("skipped");
    expect(h.completed).not.toHaveBeenCalled();
  });
  it("rejects another repository, attempt or commit before storing success", async () => {
    const f = await fixture();
    await expect(
      synchronizeGitHubRun(
        f.ctx,
        f.workflow,
        { ...f.remote, repository: { id: 2, full_name: "other/repo" } },
        f.api,
      ),
    ).rejects.toMatchObject({ code: "ACTIONS_GITHUB_IDENTITY_MISMATCH" });
    const job = (await f.jobs())[0];
    f.jobs.mockResolvedValue([{ ...job, run_attempt: 2 }]);
    await expect(synchronizeGitHubRun(f.ctx, f.workflow, f.remote, f.api)).rejects.toMatchObject({
      code: "ACTIONS_GITHUB_IDENTITY_MISMATCH",
    });
    expect(await h.repo.runs(f.org)).toHaveLength(0);
  });
  it("does not treat ambiguous branch/tag names or pull requests as branch approvals", async () => {
    const f = await fixture();
    vi.mocked(f.api.matchingRefs).mockResolvedValue(["refs/heads/main", "refs/tags/main"]);
    expect(await resolveGitHubRunRef(f.remote, f.api)).toBe("refs/unknown/main");
    expect(
      await resolveGitHubRunRef(
        { ...f.remote, event: "pull_request", pull_requests: [{ number: 3 }] },
        f.api,
      ),
    ).toBe("refs/pull/3/merge");
  });
  it("links scheduled Jobs and retries their completion without dispatching another workflow", async () => {
    const f = await fixture();
    const sourceJob = { key: "nightly", label: "Nightly", trigger: "schedule" };
    const receipt = await h.repo.beginGitHubCommand({
      id: generateId("cmd"),
      organizationId: f.org,
      workflowId: f.workflow.id,
      idempotencyKey: "timer",
      requestHash: "request",
      sourceJob,
    });
    await h.repo.finishGitHubCommand(f.org, receipt.command.id, {
      state: "accepted",
      remoteRunId: "10",
      remoteAttempt: 1,
      error: null,
    });
    h.completed.mockRejectedValueOnce(new Error("dependent temporarily unavailable"));
    await expect(synchronizeGitHubRun(f.ctx, f.workflow, f.remote, f.api)).rejects.toThrow(
      "dependent temporarily unavailable",
    );
    const [pending] = await h.repo.runs(f.org);
    expect(pending.settledAt).toBeNull();
    expect(pending.configuration.sourceJob).toEqual(sourceJob);
    const complete = await synchronizeGitHubRun(f.ctx, f.workflow, f.remote, f.api);
    expect(complete.settledAt).toBeTruthy();
    expect(h.completed).toHaveBeenCalledTimes(2);
    expect(await h.repo.runs(f.org)).toHaveLength(1);
  });
});
