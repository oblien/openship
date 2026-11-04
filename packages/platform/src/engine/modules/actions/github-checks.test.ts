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
const prBase = "b".repeat(40),
  prHead = "c".repeat(40);
function pullRequestRun(): ActionRun {
  return {
    ...run,
    eventName: "pull_request",
    ref: "refs/pull/42/merge",
    event: {
      number: 42,
      action: "synchronize",
      repository: { id: 10, full_name: "acme/app" },
      pull_request: {
        number: 42,
        state: "open",
        merged: false,
        merge_commit_sha: run.revision,
        base: { sha: prBase, ref: "main", repo: { id: 10, full_name: "acme/app" } },
        head: { sha: prHead, ref: "feature", repo: { id: 10, full_name: "acme/app" } },
      },
    },
  };
}
const identity = {
  id: 42,
  external_id: "openship-action:run-one:job-one",
  name: "Openship / CI / test",
  head_sha: prHead,
};
function prTransport(
  options: {
    saved?: object;
    parents?: string[];
    recovered?: object[];
    lostResponse?: boolean;
    createdId?: number;
  } = {},
) {
  const remote = [...(options.recovered ?? [])];
  h.request.mockImplementation(async ({ url, method, params }) => {
    if (url.includes("/git/commits/"))
      return {
        sha: run.revision,
        parents: (options.parents ?? [prBase, prHead]).map((sha) => ({ sha })),
      };
    if (method === "GET" && url.endsWith("/check-runs/42")) return options.saved ?? identity;
    if (method === "GET" && url.includes("/check-runs?")) return { check_runs: remote };
    if (method === "POST") {
      remote.push({
        ...identity,
        id: options.createdId ?? 42,
        name: params.name,
        head_sha: params.head_sha,
        external_id: params.external_id,
      });
      if (options.lostResponse) throw new Error("Response lost after creation");
      return { id: options.createdId ?? 42 };
    }
    if (method === "PATCH") return {};
    throw new Error(`Unexpected Check request: ${url}`);
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  h.resolve.mockResolvedValue({ organizationId: "org" });
  h.token.mockResolvedValue("test-app-token");
});

describe("Actions GitHub Checks delivery", () => {
  it("publishes a verified PR merge on the captured head", async () => {
    prTransport();
    expect(await syncActionCheck(pullRequestRun(), job)).toEqual({ id: "42", error: null });
    expect(h.request.mock.calls.at(-1)![0]).toMatchObject({
      method: "POST",
      params: {
        head_sha: prHead,
        conclusion: "success",
        output: { summary: expect.stringContaining(`merge revision ${run.revision}`) },
      },
    });
    expect(h.request.mock.calls.some(([request]) => request.url.includes("/pulls/"))).toBe(false);
  });
  it.each([
    [prBase, "d".repeat(40)],
    ["d".repeat(40), prHead],
    [prHead, prBase],
    [prBase],
    [prBase, prHead, prBase],
  ])("never creates a passing head Check for an unverified merge (%j)", async (...parents) => {
    prTransport({ parents });
    expect(await syncActionCheck(pullRequestRun(), job)).toMatchObject({
      id: null,
      unavailable: true,
      error: expect.stringContaining("executed merge"),
    });
    expect(
      h.request.mock.calls.some(([request]) => ["POST", "PATCH"].includes(request.method)),
    ).toBe(false);
  });
  it.each([
    { head_sha: run.revision },
    { name: "Unrelated Check" },
    { external_id: "another-attempt" },
  ])("replaces a mismatched stored Check without patching it (%j)", async (patch) => {
    prTransport({ saved: { ...identity, ...patch }, createdId: 43 });
    expect(await syncActionCheck(pullRequestRun(), { ...job, checkRunId: "42" })).toEqual({
      id: "43",
      error: null,
    });
    expect(h.request.mock.calls.some(([request]) => request.method === "PATCH")).toBe(false);
    expect(h.request.mock.calls.at(-1)![0]).toMatchObject({
      method: "POST",
      params: { head_sha: prHead },
    });
  });
  it("reuses a stored Check only after matching its attempt, name and head", async () => {
    prTransport();
    expect(await syncActionCheck(pullRequestRun(), { ...job, checkRunId: "42" })).toEqual({
      id: "42",
      error: null,
    });
    expect(h.request.mock.calls.map(([request]) => request.method)).toEqual(["GET", "PATCH"]);
    expect(h.request.mock.calls[0]![0].url).toBe(
      "https://api.github.com/repos/acme/app/check-runs/42",
    );
  });
  it("keeps the execution revision visible when a long job error is bounded", async () => {
    prTransport();
    await syncActionCheck(pullRequestRun(), { ...job, error: "x".repeat(10_000) });
    const summary = h.request.mock.calls.at(-1)![0].params.output.summary as string;
    expect(summary).toContain(`merge revision ${run.revision}`);
    expect(summary.length).toBeLessThanOrEqual(4001);
  });
  it("rejects a same-attempt lookup with the wrong Check name or SHA", async () => {
    prTransport({
      recovered: [
        { ...identity, head_sha: run.revision },
        { ...identity, name: "Wrong name" },
      ],
    });
    await syncActionCheck(pullRequestRun(), job);
    expect(h.request.mock.calls.at(-1)![0]).toMatchObject({
      method: "POST",
      params: { head_sha: prHead },
    });
    expect(h.request.mock.calls.some(([request]) => request.method === "PATCH")).toBe(false);
  });
  it("recovers a lost head-Check creation without creating another", async () => {
    prTransport({ lostResponse: true });
    expect(await syncActionCheck(pullRequestRun(), job)).toMatchObject({
      id: null,
      error: "Response lost after creation",
    });
    expect(await syncActionCheck(pullRequestRun(), job)).toEqual({ id: "42", error: null });
    expect(h.request.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
    expect(h.request.mock.calls.at(-1)![0]).toMatchObject({ method: "PATCH" });
  });
  it("does not publish with malformed or unrelated captured PR identities", async () => {
    for (const patch of [
      { ref: "refs/pull/43/merge" },
      { revision: "abc1234" },
      { event: { ...pullRequestRun().event, number: 43 } },
      { configuration: { ...run.configuration, repo: "other" } },
    ]) {
      expect(await syncActionCheck({ ...pullRequestRun(), ...patch }, job)).toMatchObject({
        unavailable: true,
        error: expect.any(String),
      });
    }
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });
  it("retries a proof read failure without publishing a passing head Check", async () => {
    prTransport();
    const normal = h.request.getMockImplementation()!;
    h.request.mockImplementation((input) =>
      input.url.includes("/git/commits/")
        ? Promise.reject(new Error("GitHub unavailable"))
        : normal(input),
    );
    expect(await syncActionCheck(pullRequestRun(), job)).toMatchObject({
      error: "GitHub unavailable",
    });
    expect(h.request.mock.calls.some(([request]) => request.method === "POST")).toBe(false);
  });
  it.each([false, true])(
    "reports closed cleanup on its executed commit (merged=%s)",
    async (merged) => {
      const attempt = pullRequestRun();
      attempt.event.action = "closed";
      Object.assign(attempt.event.pull_request as object, { state: "closed", merged });
      attempt.revision = merged ? run.revision : prHead;
      attempt.ref = merged ? "refs/heads/main" : "refs/pull/42/head";
      prTransport();
      await syncActionCheck(attempt, job);
      expect(h.request.mock.calls.at(-1)![0]).toMatchObject({
        method: "POST",
        params: { head_sha: attempt.revision },
      });
      expect(h.request.mock.calls.some(([request]) => request.url.includes("/git/commits/"))).toBe(
        false,
      );
    },
  );
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
