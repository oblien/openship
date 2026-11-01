import "../jobs/_env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateId } from "@repo/core";
import { db, schema, repos, seedOwner } from "../jobs/_harness";
import { triggerDeployment } from "@repo/platform/engine/modules/deployments/build.service";
import { resolveExecutionAuthority } from "@repo/platform/engine/lib/execution-authority";
import { env } from "@repo/platform/engine/config/env";
import { actionDeploymentController } from "@repo/platform/engine/modules/actions/deployment-gate";
import { githubFetch } from "@repo/platform/engine/modules/github/github.auth";

const remote = vi.hoisted(() => ({ head: "b".repeat(40) }));
vi.mock("@repo/platform/engine/modules/github/github.auth", async (original) => ({
  ...(await original<object>()),
  // GitHub is the only external boundary: the actual trigger, authority,
  // project lock, durable request, and delivery ledger run together.
  githubFetch: vi.fn(async () => ({ sha: remote.head, default_branch: "main" })),
}));
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const owner = await seedOwner();
  const projectId = generateId("proj"),
    groupId = generateId("app");
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
      gitUrl: "https://github.com/acme/app.git",
      autoDeploy: true,
    });
  const active = (await repos.deployment.create({
    projectId,
    organizationId: owner.orgId,
    branch: "main",
    status: "building",
    trigger: "webhook",
    commitSha: "a".repeat(40),
  }))!;
  const ctx = await resolveExecutionAuthority(
    {
      version: 1,
      userId: owner.userId,
      organizationId: owner.orgId,
      token: null,
      restrictions: null,
    },
    "test-forwarded-push",
  );
  return { owner, projectId, active, ctx };
}

describe("busy push admission through the real deployment entry", () => {
  it.each([false, true])("durably accepts a blocked push in Cloud mode=%s", async (cloud) => {
    const previous = env.CLOUD_MODE;
    env.CLOUD_MODE = cloud;
    try {
      const f = await fixture();
      const result = await triggerDeployment(f.ctx, {
        projectId: f.projectId,
        trigger: "webhook",
        branch: "main",
        commitSha: remote.head.toUpperCase(),
        serviceIds: ["push-local-scope"],
      });
      expect(result).toMatchObject({
        skipped: true,
        queuedPush: true,
        awaitingActions: {
          projectId: f.projectId,
          revision: remote.head,
          status: "waiting",
          intent: { kind: "push", smartRoute: true, repository: "acme/app" },
          authority: { userId: f.owner.userId, organizationId: f.owner.orgId },
        },
      });
      expect(result.awaitingActions?.intent.serviceIds).toBeUndefined();
      expect((await repos.deployment.listByProject(f.projectId)).rows).toHaveLength(1);
      expect((await repos.webhookDelivery.listByProject(f.projectId)).rows).toEqual([
        expect.objectContaining({ outcome: "queued", actionRef: result.awaitingActions!.id }),
      ]);
    } finally {
      env.CLOUD_MODE = previous;
    }
  });

  it("keeps native background-job policy: never acknowledge a queue that cannot run", async () => {
    const f = await fixture();
    vi.stubEnv("OPENSHIP_NATIVE", "true");
    vi.stubEnv("OPENSHIP_NATIVE_JOBS", "false");
    await expect(
      triggerDeployment(f.ctx, {
        projectId: f.projectId,
        trigger: "webhook",
        branch: "main",
        commitSha: remote.head,
      }),
    ).rejects.toMatchObject({ code: "DEPLOYMENT_IN_PROGRESS" });
    expect(await repos.actions.projectActionDeployments(f.owner.orgId, f.projectId)).toHaveLength(
      0,
    );
  });

  it("does not turn a manual request into a pending automatic deployment", async () => {
    const f = await fixture();
    await expect(
      triggerDeployment(f.ctx, {
        projectId: f.projectId,
        trigger: "manual",
        branch: "main",
        commitSha: remote.head,
      }),
    ).rejects.toMatchObject({ code: "DEPLOYMENT_IN_PROGRESS" });
    expect(await repos.actions.projectActionDeployments(f.owner.orgId, f.projectId)).toHaveLength(
      0,
    );
  });

  it("waits for the predecessor without repeatedly polling GitHub", async () => {
    const f = await fixture();
    const result = await triggerDeployment(f.ctx, {
      projectId: f.projectId,
      trigger: "webhook",
      branch: "main",
      commitSha: remote.head,
    });
    const calls = vi.mocked(githubFetch).mock.calls.length;
    await actionDeploymentController.tick(new Date(Date.now() + 20_000));
    expect(vi.mocked(githubFetch)).toHaveBeenCalledTimes(calls);
    expect(
      await repos.actions.actionDeployment(f.owner.orgId, result.awaitingActions!.id),
    ).toMatchObject({ status: "waiting", deploymentId: null });
  });
});
