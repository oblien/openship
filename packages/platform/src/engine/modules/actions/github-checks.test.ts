import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@repo/core";
import type { ActionRun, ActionJob } from "@repo/db";
const h = vi.hoisted(() => ({ resolve: vi.fn(), token: vi.fn(), request: vi.fn() }));
vi.mock("../../lib/execution-authority", () => ({ resolveExecutionAuthority: h.resolve }));
vi.mock("../github/github.auth", () => ({ getInstallationToken: h.token, githubFetch: h.request }));
vi.mock("../../config/env", () => ({ localDashboardUrl: "https://app.example.test" }));
import { syncActionCheck } from "./github-checks";
import { actionRunView } from "./views";
import { parseActionWorkflow } from "./workflow";
const run: ActionRun = {
  id: "run-one",
  organizationId: "org",
  workflowId: "workflow-one",
  controller: "openship",
  github: null,
  number: 1,
  attempt: 1,
  originalRunId: null,
  idempotencyKey: "dispatch-one",
  status: "queued",
  source: "name: CI\non: workflow_dispatch\njobs: {}",
  revision: "a".repeat(40),
  ref: "refs/heads/main",
  eventName: "workflow_dispatch",
  event: {},
  inputs: {},
  actor: "owner",
  untrusted: false,
  authority: {
    version: 1,
    userId: "owner",
    organizationId: "org",
    token: null,
    restrictions: null,
  },
  configuration: {
    owner: "acme",
    repo: "app",
    path: ".openship/workflows/ci.yml",
    defaultBranch: "main",
    runnerIds: [],
    variables: {},
    secrets: {},
  },
  plan: { name: "CI", triggers: {}, jobs: [] },
  approvedAt: null,
  approvedBy: null,
  approvalKey: null,
  admission: null,
  concurrencyGroup: null,
  cancelInProgress: false,
  expandedJobs: [],
  cancelRequestedAt: null,
  leaseOwner: null,
  leaseUntil: null,
  error: null,
  startedAt: null,
  finishedAt: null,
  settledAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const job = {
  id: "job-one",
  jobKey: "test",
  checkRunId: null,
  status: "success",
  startedAt: new Date(),
  finishedAt: new Date(),
} as ActionJob;
beforeEach(() => {
  vi.resetAllMocks();
  h.resolve.mockResolvedValue({ organizationId: "org" });
  h.token.mockResolvedValue("test-app-token");
});

describe("Actions GitHub Checks delivery", () => {
  it.each(["skipped", "cancelled", "failure"] as const)(
    "keeps the declared job name in the UI and Checks when %s before expansion",
    async (status) => {
      const plan = await parseActionWorkflow(`name: CI
on: workflow_dispatch
jobs:
  build:
    name: Build after tests
    runs-on: self-hosted
    steps:
      - run: echo build
`);
      const attempt = { ...run, plan };
      const unexpanded = { ...job, jobKey: "build", status, spec: null };
      h.request.mockImplementation(async ({ method }: { method: string }) =>
        method === "GET" ? { check_runs: [], total_count: 0 } : { id: 42 },
      );
      expect(actionRunView(attempt, [unexpanded]).jobs[0]?.name).toBe("Build after tests");
      expect(await syncActionCheck(attempt, unexpanded)).toEqual({ id: "42", error: null });
      expect(h.request.mock.calls.at(-1)?.[0]).toMatchObject({
        method: "POST",
        params: {
          name: "Openship / CI / Build after tests",
          conclusion: status,
          output: { title: "CI · Build after tests" },
        },
      });
    },
  );

  it("never publishes an independent Check for a GitHub-owned run", async () => {
    await syncActionCheck({ ...run, controller: "github" }, { ...job, checkRunId: "github-check" });
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.token).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });
  it("reconciles an accepted creation after the HTTP response was lost", async () => {
    const stored: { id: number; external_id: string }[] = [];
    h.request.mockImplementation(
      async ({ method, params }: { method: string; params?: Record<string, unknown> }) => {
        if (method === "GET") return { check_runs: stored, total_count: stored.length };
        if (method === "POST") {
          stored.push({ id: 42, external_id: String(params?.external_id) });
          throw new Error("Connection closed after commit");
        }
        return { id: 42 };
      },
    );
    expect(await syncActionCheck(run, job)).toMatchObject({
      id: null,
      error: "Connection closed after commit",
    });
    expect(await syncActionCheck(run, job)).toEqual({ id: "42", error: null });
    expect(h.request.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
    expect(h.request.mock.calls.at(-1)?.[0]).toMatchObject({
      method: "PATCH",
      params: { conclusion: "success" },
    });
    expect(h.request.mock.calls.at(-1)?.[0].params).not.toHaveProperty("head_sha");
  });

  it("never updates a same-name Check belonging to a different attempt", async () => {
    h.request.mockImplementation(async ({ method }: { method: string }) =>
      method === "GET"
        ? { check_runs: [{ id: 7, external_id: "another-job" }], total_count: 1 }
        : { id: 8 },
    );
    expect(await syncActionCheck(run, job)).toEqual({ id: "8", error: null });
    expect(h.request.mock.calls.at(-1)?.[0]).toMatchObject({
      method: "POST",
      params: { head_sha: run.revision, external_id: "openship-action:run-one:job-one" },
    });
  });

  it("stops revoked background writes but retries a temporary authorization outage", async () => {
    h.resolve
      .mockRejectedValueOnce(new AppError("Revoked", 401))
      .mockRejectedValueOnce(new Error("Database unavailable"));
    expect(await syncActionCheck(run, job)).toMatchObject({ unavailable: true, error: "Revoked" });
    expect(await syncActionCheck(run, job)).not.toHaveProperty("unavailable");
    expect(h.request).not.toHaveBeenCalled();
  });

  it("does not publish Checks with a personal credential when no App is connected", async () => {
    h.token.mockResolvedValue(null);
    expect(await syncActionCheck(run, job)).toMatchObject({ unavailable: true });
    expect(h.request).not.toHaveBeenCalled();
  });
});
