import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  workflows: vi.fn(),
  installation: vi.fn(),
  error: vi.fn(),
  resolve: vi.fn(),
  fetch: vi.fn(),
  file: vi.fn(),
  trigger: vi.fn(),
  rerun: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    actions: { matchingWorkflows: h.workflows, workflowError: h.error },
    gitInstallation: { findByOrgAndOwner: h.installation },
  },
}));
vi.mock("../../lib/execution-authority", () => ({ resolveExecutionAuthority: h.resolve }));
vi.mock("../../lib/cache-store/index", () => ({ cacheStore: vi.fn() }));
vi.mock("../../native/execution-policy", () => ({ nativeJobsEnabled: () => true }));
vi.mock("../github/github.auth", () => ({ githubFetch: h.fetch }));
vi.mock("../github/github.service", () => ({ getFileContent: h.file }));
vi.mock("./action.service", () => ({
  triggerActionWorkflow: h.trigger,
  rerunActionWorkflow: h.rerun,
}));
import { dispatchActionWebhook } from "./triggers";

const base = "a".repeat(40),
  head = "b".repeat(40),
  merge = "c".repeat(40),
  old = "d".repeat(40);
const target = { organizationId: "org", workflowId: "workflow" };
const source = `name: CI
on:
  pull_request:
    types: [opened, reopened, synchronize, closed]
jobs:
  test:
    runs-on: self-hosted
    steps:
      - run: echo test
`;
function event() {
  return {
    action: "opened",
    number: 42,
    installation: { id: 99 },
    repository: { id: 10, full_name: "acme/app", default_branch: "main" },
    sender: { id: 1, login: "owner" },
    pull_request: {
      number: 42,
      state: "open",
      merged: false,
      merge_commit_sha: null as string | null,
      base: { sha: base, ref: "main", repo: { id: 10, full_name: "acme/app" } },
      head: { sha: head, ref: "feature", repo: { id: 10, full_name: "acme/app" } },
    },
  };
}
let current: ReturnType<typeof event>["pull_request"] & { mergeable: boolean | null };
let commit: { sha: string; parents: Array<{ sha: string }> };
beforeEach(() => {
  vi.resetAllMocks();
  current = { ...event().pull_request, mergeable: true, merge_commit_sha: merge };
  commit = { sha: merge, parents: [{ sha: base }, { sha: head }] };
  h.workflows.mockResolvedValue([
    {
      ...target,
      id: target.workflowId,
      controller: "openship",
      owner: "acme",
      repo: "app",
      path: ".github/workflows/ci.yml",
      authority: {},
      allowForks: true,
    },
  ]);
  h.installation.mockResolvedValue({ installationId: 99 });
  h.resolve.mockResolvedValue({ organizationId: "org" });
  h.file.mockResolvedValue({ content: source });
  h.fetch.mockImplementation(async ({ url }) => {
    if (url.endsWith("/pulls/42")) return current;
    if (url.endsWith(`/git/commits/${merge}`)) return commit;
    throw new Error(`Unexpected GitHub request: ${url}`);
  });
});
const dispatch = (value = event()) =>
  dispatchActionWebhook("pull_request", value, "delivery", target);

describe("independent pull request webhook revisions", () => {
  it.each(["opened", "reopened", "synchronize"])(
    "resolves a null webhook merge before dispatch (%s)",
    async (action) => {
      const payload = { ...event(), action };
      await dispatch(payload);
      expect(h.trigger).toHaveBeenCalledOnce();
      expect(h.trigger.mock.calls[0]![2]).toMatchObject({
        revision: merge,
        ref: "refs/pull/42/merge",
        workflowRevision: base,
        event: payload,
        untrusted: false,
      });
      expect(h.file).toHaveBeenCalledWith(
        expect.anything(),
        "acme",
        "app",
        ".github/workflows/ci.yml",
        { branch: base },
      );
      expect(h.fetch.mock.calls.map(([request]) => request.url)).toEqual([
        "https://api.github.com/repos/acme/app/pulls/42",
        `https://api.github.com/repos/acme/app/git/commits/${merge}`,
      ]);
    },
  );
  it("ignores a stale merge in the signed snapshot and executes the verified current merge", async () => {
    const payload = event();
    payload.action = "synchronize";
    payload.pull_request.merge_commit_sha = old;
    await dispatch(payload);
    expect(h.trigger.mock.calls[0]![2]).toMatchObject({ revision: merge, event: payload });
    expect(h.fetch.mock.calls.some(([request]) => request.url.includes(old))).toBe(false);
  });
  it.each([
    [
      "head commit",
      () => {
        current.head.sha = old;
      },
    ],
    [
      "base commit",
      () => {
        current.base.sha = old;
      },
    ],
    [
      "head branch",
      () => {
        current.head.ref = "other";
      },
    ],
    [
      "base branch",
      () => {
        current.base.ref = "release";
      },
    ],
    [
      "head repository",
      () => {
        current.head.repo = { id: 20, full_name: "fork/app" };
      },
    ],
    [
      "base repository ID",
      () => {
        current.base.repo.id = 20;
      },
    ],
    [
      "base repository name",
      () => {
        current.base.repo.full_name = "acme/other";
      },
    ],
    [
      "PR number",
      () => {
        current.number = 43;
      },
    ],
    [
      "closed state",
      () => {
        current.state = "closed";
      },
    ],
    [
      "merged state",
      () => {
        current.merged = true;
      },
    ],
    [
      "merge conflicts",
      () => {
        current.mergeable = false;
      },
    ],
  ] as const)("rejects a changed %s without running code", async (_label, change) => {
    change();
    await expect(dispatch()).rejects.toThrow();
    expect(h.trigger).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith("org", "workflow", expect.any(String));
  });
  it.each([
    [
      "mergeability",
      () => {
        current.mergeable = null;
      },
    ],
    [
      "missing merge SHA",
      () => {
        current.merge_commit_sha = null;
      },
    ],
    [
      "abbreviated merge SHA",
      () => {
        current.merge_commit_sha = "abc1234";
      },
    ],
    [
      "commit receipt SHA",
      () => {
        commit.sha = old;
      },
    ],
    [
      "base parent",
      () => {
        commit.parents[0]!.sha = old;
      },
    ],
    [
      "head parent",
      () => {
        commit.parents[1]!.sha = old;
      },
    ],
    [
      "reversed parents",
      () => {
        commit.parents.reverse();
      },
    ],
    [
      "single parent",
      () => {
        commit.parents.pop();
      },
    ],
    [
      "extra parent",
      () => {
        commit.parents.push({ sha: old });
      },
    ],
  ] as const)("leaves pending %s retryable in the existing inbox", async (_label, change) => {
    change();
    await expect(dispatch()).rejects.toThrow(/test merge is not ready/);
    expect(h.trigger).not.toHaveBeenCalled();
  });
  it.each([
    ["PR read", "/pulls/42"],
    ["commit read", `/git/commits/${merge}`],
  ])("retries a failed %s without trusting the webhook merge", async (_label, suffix) => {
    const normal = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation((input) =>
      input.url.endsWith(suffix)
        ? Promise.reject(new Error("GitHub temporarily unavailable"))
        : normal(input),
    );
    const payload = event();
    payload.pull_request.merge_commit_sha = old;
    await expect(dispatch(payload)).rejects.toThrow("GitHub temporarily unavailable");
    expect(h.trigger).not.toHaveBeenCalled();
  });
  it.each([
    [
      "outer number",
      (payload: ReturnType<typeof event>) => {
        payload.number = 0;
      },
    ],
    [
      "inner number",
      (payload: ReturnType<typeof event>) => {
        payload.pull_request.number = 43;
      },
    ],
    [
      "head SHA",
      (payload: ReturnType<typeof event>) => {
        payload.pull_request.head.sha = "abc1234";
      },
    ],
    [
      "base SHA",
      (payload: ReturnType<typeof event>) => {
        payload.pull_request.base.sha = "main";
      },
    ],
    [
      "base ref",
      (payload: ReturnType<typeof event>) => {
        payload.pull_request.base.ref = "";
      },
    ],
    [
      "repository",
      (payload: ReturnType<typeof event>) => {
        payload.repository.full_name = "other/app";
      },
    ],
    [
      "repository ID",
      (payload: ReturnType<typeof event>) => {
        payload.repository.id = 20;
      },
    ],
    [
      "head identity",
      (payload: ReturnType<typeof event>) => {
        payload.pull_request.head.repo.full_name = "fork/app";
      },
    ],
  ] as const)("refuses malformed event %s before API reads", async (_label, change) => {
    const payload = event();
    change(payload);
    await expect(dispatch(payload)).rejects.toThrow(/does not identify/);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.trigger).not.toHaveBeenCalled();
  });
  it("keeps verified fork runs untrusted", async () => {
    const payload = event();
    payload.pull_request.head.repo = { id: 20, full_name: "fork/app" };
    current.head = structuredClone(payload.pull_request.head);
    await dispatch(payload);
    expect(h.trigger.mock.calls[0]![2]).toMatchObject({ revision: merge, untrusted: true });
  });
  it.each(["closed", "merged"])(
    "refuses a non-closed action carrying a %s snapshot",
    async (state) => {
      const payload = event();
      if (state === "closed") payload.pull_request.state = "closed";
      else payload.pull_request.merged = true;
      await expect(dispatch(payload)).rejects.toThrow(/not an open-PR delivery/);
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.trigger).not.toHaveBeenCalled();
    },
  );
  it("does not resolve forbidden forks", async () => {
    h.workflows.mockResolvedValueOnce([{ ...target, id: target.workflowId, allowForks: false }]);
    const payload = event();
    payload.pull_request.head.repo = { id: 20, full_name: "fork/app" };
    await dispatch(payload);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.trigger).not.toHaveBeenCalled();
  });
  it("does not resolve events excluded by the workflow's types or branch filter", async () => {
    h.file.mockResolvedValueOnce({
      content: source.replace("[opened, reopened, synchronize, closed]", "[closed]"),
    });
    await dispatch();
    h.file.mockResolvedValueOnce({
      content: source.replace(
        "types: [opened, reopened, synchronize, closed]",
        "branches: [release]",
      ),
    });
    await dispatch();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.trigger).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "dispatches closed cleanup with an immutable revision (merged=%s)",
    async (merged) => {
      const payload = event();
      payload.action = "closed";
      Object.assign(payload.pull_request, {
        state: "closed",
        merged,
        merge_commit_sha: merged ? merge : null,
      });
      await dispatch(payload);
      expect(h.trigger.mock.calls[0]![2]).toMatchObject({
        revision: merged ? merge : head,
        ref: merged ? "refs/heads/main" : "refs/pull/42/head",
        workflowRevision: base,
      });
      expect(h.fetch).not.toHaveBeenCalled();
    },
  );
});
