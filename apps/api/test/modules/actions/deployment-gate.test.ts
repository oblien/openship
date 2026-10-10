import "../jobs/_env";
import { describe, expect, it, vi } from "vitest";
import { AppError, generateId, type ExecutionAuthority } from "@repo/core";
import { eq, type ActionRun, type ActionDeploymentRequest } from "@repo/db";
import { db, schema, repos, seedOwner } from "../jobs/_harness";
import { ActionDeploymentController } from "@repo/platform/engine/modules/actions/deployment-gate";
import { parseActionWorkflow } from "@repo/platform/engine/modules/actions/workflow";

const revision = "a".repeat(40);
const source =
  "name: CI\non: push\njobs:\n  check:\n    runs-on: [self-hosted, linux]\n    steps:\n      - run: echo checked\n";

async function fixture() {
  const owner = await seedOwner();
  const groupId = generateId("app"),
    projectId = generateId("proj"),
    workflowId = generateId("awf");
  const authority: ExecutionAuthority = {
    version: 1,
    userId: owner.userId,
    organizationId: owner.orgId,
    token: null,
    restrictions: null,
  };
  await db
    .insert(schema.projectGroup)
    .values({ id: groupId, organizationId: owner.orgId, name: "App", slug: groupId });
  await db
    .insert(schema.project)
    .values({
      id: projectId,
      groupId,
      organizationId: owner.orgId,
      name: "App",
      slug: projectId,
      gitOwner: "acme",
      gitRepo: "app",
      gitBranch: "main",
      autoDeploy: true,
    });
  const plan = await parseActionWorkflow(source);
  const workflow = await repos.actions.saveWorkflow({
    id: workflowId,
    organizationId: owner.orgId,
    name: "CI",
    owner: "acme",
    repo: "app",
    path: ".github/workflows/ci.yml",
    ref: "main",
    source,
    definition: plan,
    runnerIds: [],
    authority,
  });
  await repos.actions.configureProject(owner.orgId, projectId, {
    enabled: true,
    workflowIds: [workflowId],
    requiredWorkflowIds: [workflowId],
  });
  const queue = (sha = revision) =>
    repos.actions.queueActionDeployment({
      id: generateId("adep"),
      organizationId: owner.orgId,
      projectId,
      revision: sha,
      ref: "refs/heads/main",
      requirements: {},
      intent: {},
      authority,
    });
  const receipt = (await queue())!;
  const state = { head: revision, failAfterInsert: false, kickoffs: 0 };
  const run = async (patch: Partial<ActionRun> = {}) =>
    repos.actions.createRun({
      id: generateId("arun"),
      organizationId: owner.orgId,
      workflowId,
      idempotencyKey: generateId("key"),
      source,
      plan,
      configuration: {
        owner: "acme",
        repo: "app",
        path: workflow.path,
        defaultBranch: "main",
        runnerIds: [],
        variables: {},
        secrets: {},
        workflowVersion: workflow.updatedAt.toISOString(),
      },
      authority,
      revision,
      ref: "refs/heads/main",
      eventName: "push",
      event: {},
      actor: "Owner",
      status: "success",
      finishedAt: new Date(),
      settledAt: new Date(),
      ...patch,
    });
  const report = vi.fn();
  const dispatchChecks = vi.fn(async (_request: ActionDeploymentRequest, ids: string[]) => {
    for (const workflowId of ids)
      await run({ workflowId, status: "queued", finishedAt: null, settledAt: null });
  });
  const deploy = vi.fn(async (request: ActionDeploymentRequest, lease: string) => {
    let deployment = await repos.actions.deploymentForActionRequest(owner.orgId, request.id);
    if (!deployment)
      deployment = await repos.deployment.create(
        {
          projectId,
          organizationId: owner.orgId,
          status: "queued",
          trigger: "actions",
          branch: "main",
          commitSha: request.revision,
          actionRequestId: request.id,
        },
        undefined,
        lease,
      );
    if (!deployment)
      throw new AppError("A deployment is already running", 409, "DEPLOYMENT_IN_PROGRESS");
    if (state.failAfterInsert) {
      state.failAfterInsert = false;
      throw new Error("Controller stopped before queue submission");
    }
    state.kickoffs++;
    return deployment.id;
  });
  const ports = {
    repo: {
      ...repos.actions,
      pendingActionDeployments: async (now: Date) =>
        (await repos.actions.pendingActionDeployments(now)).filter(
          (item) => item.projectId === projectId,
        ),
    },
    prepare: async () => {
      const current = (await repos.actions.workflow(owner.orgId, workflowId))!;
      return {
        head: state.head,
        enabled: current.enabled,
        requirements: { [workflowId]: current.updatedAt.toISOString() },
      };
    },
    dispatchChecks,
    deploy,
    reportError: report,
  };
  const controller = new ActionDeploymentController(ports);
  const tick = () => controller.tick(new Date(Date.now() + 20_000));
  const current = () => repos.actions.actionDeployment(owner.orgId, receipt.id);
  return {
    owner,
    projectId,
    workflow,
    receipt,
    queue,
    run,
    state,
    ports,
    tick,
    current,
    deploy,
    report,
    dispatchChecks,
  };
}

describe("required Actions deployment admission with real database transactions", () => {
  it("waits for the exact trusted push, then admits one deployment across controller retries", async () => {
    const f = await fixture();
    await Promise.all([
      f.tick(),
      new ActionDeploymentController(f.ports).tick(new Date(Date.now() + 20_000)),
    ]);
    expect(f.dispatchChecks).toHaveBeenCalledOnce();
    expect(f.deploy).not.toHaveBeenCalled();
    const [pending] = await repos.actions.runsForActionDeployment(
      f.owner.orgId,
      [f.workflow.id],
      revision,
      "refs/heads/main",
    );
    await db
      .update(schema.actionRun)
      .set({ status: "success", finishedAt: new Date() })
      .where(eq(schema.actionRun.id, pending!.id));
    await f.tick();
    await f.tick();
    expect(f.deploy).toHaveBeenCalledOnce();
    expect(await f.current()).toMatchObject({ status: "deployed" });
    const rows = await repos.deployment.listByProject(f.projectId);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ commitSha: revision, actionRequestId: f.receipt.id });
    expect(f.report).not.toHaveBeenCalled();
  });
  it("keeps a failed check blocked, and accepts its successful retry", async () => {
    const f = await fixture();
    const failed = await f.run({ status: "failure" });
    await f.tick();
    expect(await f.current()).toMatchObject({ status: "blocked" });
    expect(f.deploy).not.toHaveBeenCalled();
    await f.run({ originalRunId: failed.id });
    await f.tick();
    expect(await f.current()).toMatchObject({ status: "deployed" });
  });
  it.each([
    { revision: "b".repeat(40) },
    { ref: "refs/heads/other" },
    { eventName: "workflow_dispatch" },
    { untrusted: true },
  ])("ignores success with a different execution identity: %j", async (patch) => {
    const f = await fixture();
    await f.run(patch);
    await f.tick();
    expect(f.dispatchChecks).toHaveBeenCalledOnce();
    expect(f.deploy).not.toHaveBeenCalled();
  });
  it("supersedes an old SHA or changed workflow configuration before admission", async () => {
    const f = await fixture();
    await f.run();
    f.state.head = "b".repeat(40);
    await f.tick();
    expect(await f.current()).toMatchObject({ status: "superseded" });
    expect(f.deploy).not.toHaveBeenCalled();
    const other = await fixture();
    await other.run();
    await db
      .update(schema.actionWorkflow)
      .set({ updatedAt: new Date(other.workflow.updatedAt.getTime() + 1000) })
      .where(eq(schema.actionWorkflow.id, other.workflow.id));
    await other.tick();
    expect(await other.current()).toMatchObject({ status: "superseded" });
    expect(other.deploy).not.toHaveBeenCalled();
  });
  it("resumes the same accepted deployment after a crash before queue submission", async () => {
    const f = await fixture();
    await f.run();
    f.state.failAfterInsert = true;
    await f.tick();
    const interrupted = await f.current();
    expect(interrupted?.deploymentId).toBeTruthy();
    expect(f.state.kickoffs).toBe(0);
    await new ActionDeploymentController(f.ports).tick(new Date(Date.now() + 20_000));
    expect(await f.current()).toMatchObject({
      status: "deployed",
      deploymentId: interrupted!.deploymentId,
    });
    expect(f.state.kickoffs).toBe(1);
    expect((await repos.deployment.listByProject(f.projectId)).rows).toHaveLength(1);
  });
  it("fences policy changes, lease loss, and checks still running at the final DB insert", async () => {
    const f = await fixture();
    await f.run({ status: "running", finishedAt: null, settledAt: null });
    await repos.actions.claimActionDeployment(f.owner.orgId, f.receipt.id, "controller");
    await repos.actions.updateActionDeployment(
      f.owner.orgId,
      f.receipt.id,
      "controller",
      { status: "deploying" },
      false,
    );
    const insert = (lease = "controller") =>
      repos.deployment.create(
        {
          projectId: f.projectId,
          organizationId: f.owner.orgId,
          status: "queued",
          trigger: "actions",
          branch: "main",
          commitSha: revision,
          actionRequestId: f.receipt.id,
        },
        undefined,
        lease,
      );
    await expect(insert()).rejects.toMatchObject({ code: "ACTIONS_CHECKS_PENDING" });
    await expect(insert("old-controller")).rejects.toMatchObject({
      code: "ACTIONS_DEPLOYMENT_CHANGED",
    });
    await repos.actions.configureProject(f.owner.orgId, f.projectId, {
      enabled: false,
      workflowIds: [f.workflow.id],
      requiredWorkflowIds: [],
    });
    await expect(insert()).rejects.toMatchObject({ code: "ACTIONS_DEPLOYMENT_CHANGED" });
    expect((await repos.deployment.listByProject(f.projectId)).rows).toHaveLength(0);
  });
  it("supersedes pending checks when a user starts a manual deployment", async () => {
    const f = await fixture();
    await f.run();
    await repos.deployment.create({
      projectId: f.projectId,
      organizationId: f.owner.orgId,
      branch: "main",
      trigger: "manual",
      status: "queued",
    });
    await f.tick();
    expect(await f.current()).toMatchObject({ status: "superseded" });
    expect(f.deploy).not.toHaveBeenCalled();
  });
  it("does not let a webhook bypass required checks, while preserving explicit deploy hooks without a gate", async () => {
    const f = await fixture();
    const insert = () =>
      repos.deployment.create({
        projectId: f.projectId,
        organizationId: f.owner.orgId,
        branch: "main",
        trigger: "webhook",
        status: "queued",
      });
    await expect(insert()).rejects.toMatchObject({ code: "ACTIONS_DEPLOYMENT_CHANGED" });
    await repos.actions.configureProject(f.owner.orgId, f.projectId, {
      enabled: false,
      workflowIds: [],
      requiredWorkflowIds: [],
    });
    expect(await insert()).toMatchObject({ projectId: f.projectId, trigger: "webhook" });
  });
  it("keeps duplicate delivery receipts and cancellation durable", async () => {
    const f = await fixture();
    expect((await f.queue())?.id).toBe(f.receipt.id);
    await repos.actions.resetActionDeployment(f.owner.orgId, f.projectId, f.receipt.id, {
      status: "cancelled",
      error: null,
    });
    expect((await f.queue())?.status).toBe("cancelled");
    await f.tick();
    expect(f.deploy).not.toHaveBeenCalled();
    expect(
      await repos.actions.actionDeployment("another-organization", f.receipt.id),
    ).toBeUndefined();
    await expect(
      repos.actions.configureProject("another-organization", f.projectId, {
        enabled: true,
        workflowIds: [f.workflow.id],
        requiredWorkflowIds: [],
      }),
    ).rejects.toMatchObject({ code: "PROJECT_UNAVAILABLE" });
  });
  it("rejects a stale project-link edit instead of silently detaching concurrent links", async () => {
    const f = await fixture();
    await expect(repos.actions.saveWorkflow(f.workflow, [], [])).rejects.toMatchObject({
      code: "ACTIONS_PROJECT_LINKS_CHANGED",
    });
    expect(await repos.actions.workflowProjects(f.owner.orgId, f.workflow.id)).toHaveLength(1);
  });
});
