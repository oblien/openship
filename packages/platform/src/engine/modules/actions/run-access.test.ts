import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionAccessPolicy, ActionActorIdentity } from "@repo/core";
import type { ActionRun, ActionWorkflow } from "@repo/db";
import type { ExecutionContext } from "../../../context";

const mock = vi.hoisted(() => ({
  runner: vi.fn(),
  status: vi.fn(),
  user: vi.fn(),
  collaborator: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: { actions: { runner: mock.runner } } }));
vi.mock("../github/github.auth", () => ({ getUserStatus: mock.status }));
vi.mock("./github-api", () => ({
  GitHubActionsApi: class {
    user = mock.user;
    collaborator = mock.collaborator;
  },
}));
import {
  evaluateActionRunAdmission,
  githubActionActor,
  prepareActionAccessPolicy,
} from "./run-access";

const actor: ActionActorIdentity = { provider: "github", id: "42", login: "owner" };
const policy: ActionAccessPolicy = {
  version: 1,
  audience: "owner",
  owner: actor,
  users: [],
  approval: "required",
  forks: "deny",
};
const ctx = {
  userId: "local-owner",
  organizationId: "org",
  user: { name: "Owner" },
} as ExecutionContext;
function fixture() {
  const workflow = {
    id: "wf",
    owner: "acme",
    repo: "app",
    path: ".github/workflows/ci.yml",
    runnerIds: ["mac", "cloud"],
    updatedAt: new Date(0),
    accessPolicy: structuredClone(policy),
  } as ActionWorkflow;
  const run = {
    id: "run",
    controller: "github",
    revision: "a".repeat(40),
    attempt: 1,
    eventName: "push",
    untrusted: false,
    approvedAt: null,
    approvalKey: null,
    configuration: { runnerIds: ["mac", "cloud"] },
    github: { actor, triggeringActor: actor },
  } as ActionRun;
  return { workflow, run, evaluate: () => evaluateActionRunAdmission(ctx, workflow, run) };
}
beforeEach(() => {
  vi.resetAllMocks();
  mock.runner.mockImplementation(async (_org, id) => ({
    id,
    serverId: id === "mac" ? id : null,
    cloudPoolId: id === "cloud" ? "pool" : null,
    cloudProfileId: null,
    enabled: true,
    config: {
      mode: "native",
      image: null,
      labels: [],
      maxParallel: 1,
      cpu: 1,
      memoryMb: 1024,
      allowDockerSocket: false,
    },
  }));
  mock.status.mockResolvedValue({ connected: true, ...actor, id: 42 });
});

describe("workflow access policies", () => {
  it("defaults to a verified personal account, explicit approval and blocked forks", async () => {
    const result = await prepareActionAccessPolicy(ctx, { owner: "acme", repo: "app" } as any);
    expect(result).toEqual(policy);
    expect(mock.status).toHaveBeenCalledWith("local-owner", ctx);
    mock.status.mockResolvedValue({ connected: false });
    await expect(
      prepareActionAccessPolicy(ctx, { owner: "acme", repo: "app" } as any),
    ).rejects.toMatchObject({ code: "ACTIONS_GITHUB_IDENTITY_REQUIRED" });
  });
  it("resolves selected logins to durable GitHub IDs without requiring an owner OAuth token", async () => {
    mock.user.mockResolvedValue({ id: 77, login: "Reviewer" });
    const result = await prepareActionAccessPolicy(ctx, {
      owner: "acme",
      repo: "app",
      accessPolicy: {
        audience: "selected",
        users: ["Reviewer", "reviewer"],
        approval: "automatic",
        forks: "deny",
      },
    } as any);
    expect(result.users).toEqual([{ provider: "github", id: "77", login: "Reviewer" }]);
    expect(mock.user).toHaveBeenCalledTimes(1);
    expect(mock.status).not.toHaveBeenCalled();
  });
  it("keeps a saved owner when another administrator edits the policy", async () => {
    const { workflow } = fixture();
    mock.status.mockResolvedValue({ connected: true, id: 99, login: "another" });
    const result = await prepareActionAccessPolicy(
      ctx,
      { owner: "acme", repo: "app", accessPolicy: { ...policy, users: [] } } as any,
      workflow,
    );
    expect(result.owner).toEqual(actor);
    expect(mock.status).not.toHaveBeenCalled();
  });
  it("rejects missing or unsafe actor identifiers", () => {
    for (const id of [undefined, 0, -1, Number.MAX_SAFE_INTEGER + 1])
      expect(githubActionActor({ id, login: "owner" })).toBeNull();
  });
});

describe("run admission", () => {
  it("requires review and recognizes only the exact approved key", async () => {
    const f = fixture();
    const admission = await f.evaluate();
    expect(admission.state).toBe("approval_required");
    f.run.approvedAt = new Date();
    f.run.approvalKey = admission.key;
    expect((await f.evaluate()).state).toBe("allowed");
    f.run.approvalKey = "b".repeat(64);
    expect((await f.evaluate()).state).toBe("approval_required");
  });
  it.each(["commit", "attempt", "policy", "destinations"])(
    "invalidates approval when %s changes",
    async (change) => {
      const f = fixture();
      f.run.approvalKey = (await f.evaluate()).key;
      f.run.approvedAt = new Date();
      if (change === "commit") f.run.revision = "b".repeat(40);
      if (change === "attempt") f.run.attempt++;
      if (change === "policy")
        f.workflow.accessPolicy = { ...policy, audience: "selected", users: [actor] };
      if (change === "destinations") f.workflow.runnerIds = ["cloud"];
      expect((await f.evaluate()).state).toBe("approval_required");
    },
  );
  it("does not invalidate approval for notification edits or runner ordering", async () => {
    const f = fixture();
    f.run.approvalKey = (await f.evaluate()).key;
    f.run.approvedAt = new Date();
    f.workflow.updatedAt = new Date(1000);
    f.workflow.runnerIds.reverse();
    expect(await f.evaluate()).toMatchObject({
      state: "allowed",
      workflowVersion: new Date(1000).toISOString(),
    });
  });
  it("requires new review when a runner points to a different server or resource policy", async () => {
    const f = fixture();
    f.run.approvalKey = (await f.evaluate()).key;
    f.run.approvedAt = new Date();
    const previous = mock.runner.getMockImplementation()!;
    mock.runner.mockImplementation(async (...args) => ({
      ...(await previous(...args)),
      serverId: "different-host",
    }));
    expect((await f.evaluate()).state).toBe("approval_required");
  });
  it("keeps the same review key after JSONB reorders identity and policy fields", async () => {
    const f = fixture();
    const key = (await f.evaluate()).key;
    f.run.github!.actor = { login: actor.login, id: actor.id, provider: actor.provider };
    f.run.github!.triggeringActor = { id: actor.id, provider: actor.provider, login: actor.login };
    f.workflow.accessPolicy = {
      forks: policy.forks,
      users: [],
      approval: policy.approval,
      owner: { id: actor.id, login: actor.login, provider: actor.provider },
      audience: policy.audience,
      version: policy.version,
    };
    expect((await f.evaluate()).key).toBe(key);
  });
  it("does not substitute the original actor for an unverified independent rerun request", async () => {
    const f = fixture();
    f.run.controller = "openship";
    f.run.github = null;
    f.run.configuration.actorIdentity = actor;
    f.run.configuration.triggeringActorIdentity = null;
    expect((await f.evaluate()).reason).toBe("identity_unavailable");
  });
  it("checks both the original and rerun actors using IDs, not reusable usernames", async () => {
    const f = fixture();
    f.workflow.accessPolicy!.approval = "automatic";
    f.run.github!.triggeringActor = { ...actor, id: "99" };
    expect((await f.evaluate()).reason).toBe("actor_not_allowed");
    f.run.github!.triggeringActor = actor;
    f.run.github!.actor = { ...actor, id: "99" };
    expect((await f.evaluate()).reason).toBe("actor_not_allowed");
    f.run.github!.actor = { ...actor, login: "renamed" };
    expect((await f.evaluate()).state).toBe("allowed");
  });
  it("fails closed on legacy GitHub policies and missing rerun identity", async () => {
    const f = fixture();
    f.run.attempt = 2;
    f.run.github!.triggeringActor = null;
    expect((await f.evaluate()).reason).toBe("identity_unavailable");
    f.workflow.accessPolicy = null;
    expect((await f.evaluate()).reason).toBe("policy_missing");
  });
  it("requires a matching selected-user ID for each actor", async () => {
    const f = fixture();
    f.workflow.accessPolicy = {
      ...policy,
      audience: "selected",
      users: [actor],
      approval: "automatic",
    };
    expect((await f.evaluate()).state).toBe("allowed");
    f.run.github!.triggeringActor = { provider: "github", id: "99", login: actor.login };
    expect((await f.evaluate()).state).toBe("blocked");
  });
  it("verifies collaborator write access and response identity, and propagates GitHub outages", async () => {
    const f = fixture();
    f.workflow.accessPolicy = { ...policy, audience: "collaborators", approval: "automatic" };
    mock.collaborator.mockResolvedValue({ permission: "write", user: { id: 42 } });
    expect((await f.evaluate()).state).toBe("allowed");
    expect(mock.collaborator).toHaveBeenCalledTimes(1);
    mock.collaborator.mockResolvedValue({ permission: "read", user: { id: 42 } });
    expect((await f.evaluate()).state).toBe("blocked");
    mock.collaborator.mockResolvedValue({ permission: "admin", user: { id: 99 } });
    expect((await f.evaluate()).state).toBe("blocked");
    mock.collaborator.mockRejectedValue(new Error("GitHub unavailable"));
    await expect(f.evaluate()).rejects.toThrow("unavailable");
  });
  it("blocks forks by default and always reviews eligible forks, including automatic policies", async () => {
    const f = fixture();
    f.run.untrusted = true;
    f.workflow.accessPolicy!.approval = "automatic";
    expect((await f.evaluate()).reason).toBe("fork_disabled");
    f.workflow.accessPolicy!.forks = "review";
    expect((await f.evaluate()).state).toBe("approval_required");
    f.run.approvalKey = (await f.evaluate()).key;
    f.run.approvedAt = new Date();
    expect((await f.evaluate()).state).toBe("allowed");
  });
});
