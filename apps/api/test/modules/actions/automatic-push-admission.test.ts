import "../jobs/_env";
import { describe, expect, it, vi } from "vitest";
import { AppError, generateId, type ExecutionAuthority } from "@repo/core";
import { eq, type ActionDeploymentRequest } from "@repo/db";
import { db, schema, repos, seedOwner } from "../jobs/_harness";
import { ActionDeploymentController } from "@repo/platform/engine/modules/actions/deployment-gate";
import { resolveExecutionAuthority } from "@repo/platform/engine/lib/execution-authority";
import { updateOptions } from "@repo/platform/engine/modules/projects/project-crud.service";

const sha = (letter: string) => letter.repeat(40);

async function fixture() {
  const owner = await seedOwner();
  const projectId = generateId("proj"),
    groupId = generateId("app");
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
  await db.insert(schema.project).values({
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
  const state = { head: sha("b"), failAfterInsert: false, kickoffs: 0 };
  const queue = (
    revision = state.head,
    options: { forceAll?: boolean; receivedAt?: Date; expected?: string | null } = {},
  ) =>
    repos.actions.queueActionDeployment(
      {
        id: generateId("adep"),
        projectId,
        organizationId: owner.orgId,
        revision,
        ref: "refs/heads/main",
        requirements: {},
        authority,
        createdAt: options.receivedAt,
        intent: {
          kind: "push",
          repository: "acme/app",
          forceAll: options.forceAll,
          smartRoute: true,
        },
      },
      options.expected,
    );
  const create = (options: { trigger?: string; status?: string; commitSha?: string } = {}) =>
    repos.deployment.create({
      projectId,
      organizationId: owner.orgId,
      branch: "main",
      status: options.status ?? "building",
      trigger: options.trigger ?? "webhook",
      commitSha: options.commitSha ?? sha("a"),
    });
  const deploy = vi.fn(async (request: ActionDeploymentRequest, lease: string) => {
    let accepted = await repos.actions.deploymentForActionRequest(owner.orgId, request.id);
    if (!accepted)
      accepted = await repos.deployment.create(
        {
          projectId,
          organizationId: owner.orgId,
          branch: "main",
          status: "queued",
          trigger: "webhook",
          commitSha: request.revision,
          actionRequestId: request.id,
        },
        undefined,
        lease,
      );
    if (!accepted) throw new AppError("Deployment is running", 409, "DEPLOYMENT_IN_PROGRESS");
    if (state.failAfterInsert) {
      state.failAfterInsert = false;
      throw new Error("Lost kickoff acknowledgement");
    }
    state.kickoffs++;
    return accepted.id;
  });
  const dispatchChecks = vi.fn(),
    reportError = vi.fn(),
    failed = vi.fn();
  const ports = {
    repo: {
      ...repos.actions,
      pendingActionDeployments: async (now: Date) =>
        (await repos.actions.pendingActionDeployments(now)).filter(
          (row) => row.projectId === projectId,
        ),
    },
    prepare: async (request: ActionDeploymentRequest) => {
      await resolveExecutionAuthority(request.authority, "test-automatic-push");
      const target = (await repos.project.findById(projectId))!;
      return {
        head: state.head,
        enabled: target.autoDeploy && !target.disabledAt,
        requirements: {},
      };
    },
    deploy,
    dispatchChecks,
    reportError,
    failed,
  };
  const tick = () => new ActionDeploymentController(ports).tick(new Date(Date.now() + 20_000));
  const current = (id: string) => repos.actions.actionDeployment(owner.orgId, id);
  const deliveries = async () => (await repos.webhookDelivery.listByProject(projectId)).rows;
  const claim = async (id: string) => {
    await repos.actions.claimActionDeployment(owner.orgId, id, "controller");
    await repos.actions.updateActionDeployment(
      owner.orgId,
      id,
      "controller",
      { status: "deploying" },
      false,
    );
    return { organizationId: owner.orgId, projectId, requestId: id, owner: "controller" };
  };
  return {
    owner,
    projectId,
    authority,
    queue,
    create,
    state,
    ports,
    tick,
    current,
    deliveries,
    claim,
    deploy,
    failed,
  };
}

describe("automatic pushes share durable deployment admission", () => {
  it("keeps the latest push, preserves force-deploy intent, and deploys it once after the old build", async () => {
    const f = await fixture();
    const active = (await f.create())!;
    const first = (await f.queue(sha("b"), { forceAll: true, expected: active.id }))!;
    const latest = (await f.queue(sha("c"), { expected: active.id }))!;
    f.state.head = sha("c");
    expect(await f.current(first.id)).toMatchObject({ status: "superseded" });
    expect(latest.intent.forceAll).toBe(true);
    await f.tick();
    expect(await f.current(latest.id)).toMatchObject({ status: "waiting" });
    await repos.deployment.updateStatus(active.id, "ready");
    await f.tick();
    await f.tick();
    const history = (await repos.deployment.listByProject(f.projectId)).rows;
    expect(history.filter((row) => row.commitSha === sha("b"))).toHaveLength(0);
    expect(history.filter((row) => row.commitSha === sha("c"))).toHaveLength(1);
    expect(await f.deliveries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "skipped",
          summary: expect.objectContaining({ commit: sha("b") }),
        }),
        expect.objectContaining({
          outcome: "dispatched",
          summary: expect.objectContaining({ commit: sha("c") }),
        }),
      ]),
    );
    expect(f.ports.dispatchChecks).not.toHaveBeenCalled();
  });

  it.each(["manual", "rollback"])(
    "refuses stale admission when a %s deployment wins after preparation",
    async (trigger) => {
      const f = await fixture();
      const request = (await f.queue())!;
      const proof = await f.claim(request.id);
      const deliberate = (await f.create({ trigger }))!;
      await expect(f.ports.deploy(request, proof.owner)).rejects.toMatchObject({
        code: "ACTIONS_DEPLOYMENT_CHANGED",
      });
      expect(await f.current(request.id)).toMatchObject({ status: "superseded" });
      expect(await f.deliveries()).toEqual([
        expect.objectContaining({ outcome: "skipped", actionRef: deliberate.id }),
      ]);
    },
  );

  it("cannot queue an old webhook after a later deliberate deployment overtakes source preparation", async () => {
    const f = await fixture();
    const active = (await f.create())!;
    await repos.deployment.updateStatus(active.id, "ready");
    await f.create({ trigger: "rollback" });
    const request = (await f.queue(sha("b"), { expected: active.id }))!;
    expect(request.status).toBe("superseded");
    await f.tick();
    expect(f.deploy).not.toHaveBeenCalled();
  });

  it("preserves a newer queued invocation when an older source lookup finishes late", async () => {
    const f = await fixture();
    const latest = (await f.queue(sha("c"), { receivedAt: new Date(Date.now() + 1000) }))!;
    expect((await f.queue(sha("b"), { receivedAt: new Date() }))?.id).toBe(latest.id);
    f.state.head = sha("c");
    await f.tick();
    expect(f.deploy).toHaveBeenCalledOnce();
    expect(f.deploy.mock.calls[0]![0].revision).toBe(sha("c"));
  });

  it("a newer pending push invalidates a controller that already prepared the previous push", async () => {
    const f = await fixture();
    const old = (await f.queue())!;
    const proof = await f.claim(old.id);
    await f.queue(sha("c"));
    await expect(f.ports.deploy(old, proof.owner)).rejects.toMatchObject({
      code: "ACTIONS_DEPLOYMENT_CHANGED",
    });
    expect((await repos.deployment.listByProject(f.projectId)).rows).toHaveLength(0);
  });

  it("recovers an accepted deployment after restart without admitting a duplicate", async () => {
    const f = await fixture();
    const request = (await f.queue())!;
    f.state.failAfterInsert = true;
    await f.tick();
    expect((await f.current(request.id))?.deploymentId).toBeTruthy();
    expect(f.state.kickoffs).toBe(0);
    await f.tick();
    expect(await f.current(request.id)).toMatchObject({ status: "deployed" });
    expect(f.state.kickoffs).toBe(1);
    expect((await repos.deployment.listByProject(f.projectId)).rows).toHaveLength(1);
  });

  it("allows a new push at a previously deployed SHA without weakening required-check uniqueness", async () => {
    const f = await fixture();
    const first = (await f.queue())!;
    await f.tick();
    await repos.deployment.updateStatus((await f.current(first.id))!.deploymentId!, "ready");
    const second = (await f.queue())!;
    expect(second.id).not.toBe(first.id);
    await f.tick();
    expect(await f.current(second.id)).toMatchObject({ status: "deployed" });
  });

  it("does not use the newest 100 webhook history rows as the execution queue", async () => {
    const f = await fixture();
    const request = (await f.queue())!;
    await db.insert(schema.webhookDelivery).values(
      Array.from({ length: 120 }, () => ({
        id: generateId("wdl"),
        organizationId: f.owner.orgId,
        projectId: f.projectId,
        source: "github",
        event: "push",
        authResult: "ok",
        outcome: "skipped",
      })),
    );
    await f.tick();
    expect(await f.current(request.id)).toMatchObject({ status: "deployed" });
  });

  it.each(["repository", "branch", "disabled", "deleting", "required-checks"])(
    "revalidates %s at atomic admission",
    async (change) => {
      const f = await fixture();
      const request = (await f.queue())!;
      await f.claim(request.id);
      if (change === "required-checks") {
        await db
          .update(schema.actionDeployment)
          .set({ intent: {} })
          .where(eq(schema.actionDeployment.id, request.id));
      } else {
        await repos.project.update(
          f.projectId,
          change === "repository"
            ? { gitRepo: "other" }
            : change === "branch"
              ? { gitBranch: "other" }
              : change === "disabled"
                ? { disabledAt: new Date() }
                : { deletionInProgress: true },
        );
      }
      await expect(f.ports.deploy(request, "controller")).rejects.toMatchObject({
        code: change === "deleting" ? "DEPLOYMENT_IN_PROGRESS" : "ACTIONS_DEPLOYMENT_CHANGED",
      });
      expect((await repos.deployment.listByProject(f.projectId)).rows).toHaveLength(0);
    },
  );

  it("revalidates revoked membership before starting queued work and notifies once", async () => {
    const f = await fixture();
    const request = (await f.queue())!;
    await db.delete(schema.member).where(eq(schema.member.userId, f.owner.userId));
    await f.tick();
    await f.tick();
    expect(await f.current(request.id)).toMatchObject({ status: "failed" });
    expect(f.deploy).not.toHaveBeenCalled();
    expect(f.failed).toHaveBeenCalledOnce();
  });

  it("settles webhook history when automation is changed or a pending request is cancelled", async () => {
    const f = await fixture();
    const request = (await f.queue())!;
    await repos.actions.resetActionDeployment(f.owner.orgId, f.projectId, request.id, {
      status: "cancelled",
      error: null,
    });
    expect(await f.deliveries()).toEqual([expect.objectContaining({ outcome: "skipped" })]);
    await f.queue(sha("c"));
    await repos.actions.configureProject(f.owner.orgId, f.projectId, {
      enabled: false,
      workflowIds: [],
      requiredWorkflowIds: [],
    });
    expect((await f.deliveries()).every((row) => row.outcome === "skipped")).toBe(true);
  });
});

describe("opt-in automatic build cancellation", () => {
  it("waits for a cancelled worker to acknowledge cleanup before admitting its replacement", async () => {
    const f = await fixture();
    await repos.project.update(f.projectId, { autoDeployCancelBuilds: true });
    const active = (await f.create())!;
    const workerId = generateId("bld");
    await db
      .insert(schema.buildSession)
      .values({
        id: workerId,
        deploymentId: active.id,
        projectId: f.projectId,
        status: "building",
        startedAt: new Date(),
      });
    const request = (await f.queue())!;
    expect(
      await repos.deployment.cancelObsoleteAutomaticBuild(active.id, await f.claim(request.id)),
    ).toBe(true);
    // Let the normal controller retry the same durable request.
    await repos.actions.updateActionDeployment(f.owner.orgId, request.id, "controller", {
      status: "waiting",
    });
    await f.tick();
    expect((await repos.deployment.listByProject(f.projectId)).rows).toHaveLength(1);
    expect(await f.current(request.id)).toMatchObject({ status: "waiting" });
    await db
      .update(schema.buildSession)
      .set({ finishedAt: new Date() })
      .where(eq(schema.buildSession.id, workerId));
    await f.tick();
    expect(await f.current(request.id)).toMatchObject({ status: "deployed" });
    expect((await repos.deployment.listByProject(f.projectId)).rows).toHaveLength(2);
  });

  it("defaults off and saves through the shared project options service", async () => {
    const f = await fixture();
    expect((await repos.project.findById(f.projectId))?.autoDeployCancelBuilds).toBe(false);
    await updateOptions(f.projectId, { autoDeployCancelBuilds: true }, f.owner.orgId);
    expect((await repos.project.findById(f.projectId))?.autoDeployCancelBuilds).toBe(true);
    await expect(
      updateOptions(f.projectId, { autoDeployCancelBuilds: "yes" }, f.owner.orgId),
    ).rejects.toThrow();
  });

  it.each(["queued", "building"])(
    "cancels an obsolete %s automatic build without changing the live release",
    async (status) => {
      const f = await fixture();
      const live = (await f.create({ status: "ready", commitSha: sha("d") }))!;
      await repos.project.update(f.projectId, {
        activeDeploymentId: live.id,
        autoDeployCancelBuilds: true,
      });
      const active = (await f.create({ status }))!;
      const request = (await f.queue())!;
      const proof = await f.claim(request.id);
      expect(await repos.deployment.cancelObsoleteAutomaticBuild(active.id, proof)).toBe(true);
      expect(await repos.deployment.findById(active.id)).toMatchObject({ status: "cancelled" });
      expect(await repos.deployment.findById(live.id)).toMatchObject({ status: "ready" });
      expect((await repos.project.findById(f.projectId))?.activeDeploymentId).toBe(live.id);
      // A cancelled row cannot subsequently enter release/activation.
      expect(await repos.deployment.updateStatus(active.id, "deploying")).toBe(false);
    },
  );

  it.each([
    "deploying",
    "manual",
    "rollback",
    "same-commit",
    "disabled-policy",
    "superseded",
    "expired-lease",
    "other-tenant",
    "handover",
  ])("refuses automatic cancellation for %s", async (scenario) => {
    const f = await fixture();
    await repos.project.update(f.projectId, {
      autoDeployCancelBuilds: scenario !== "disabled-policy",
    });
    const active = (await f.create({
      status: scenario === "deploying" ? "deploying" : "building",
      trigger: ["manual", "rollback"].includes(scenario) ? scenario : "webhook",
      commitSha: scenario === "same-commit" ? f.state.head : sha("a"),
    }))!;
    const request = (await f.queue())!;
    const proof = await f.claim(request.id);
    if (scenario === "superseded") await f.queue(sha("c"));
    if (scenario === "expired-lease")
      await db
        .update(schema.actionDeployment)
        .set({ leaseUntil: new Date(0) })
        .where(eq(schema.actionDeployment.id, request.id));
    if (scenario === "other-tenant") proof.organizationId = "another-tenant";
    if (scenario === "handover")
      await db
        .update(schema.deployment)
        .set({ roleHandover: { phase: "committing" } as never })
        .where(eq(schema.deployment.id, active.id));
    expect(await repos.deployment.cancelObsoleteAutomaticBuild(active.id, proof)).toBe(false);
    expect((await repos.deployment.findById(active.id))?.status).toBe(active.status);
  });
});
