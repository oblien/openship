/** Signed feed → stored deployment evidence → scoped HTTP API → in-app notification.
 * GitHub transport and container execution are fixtures; all application layers and DB are real.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { db, schema, repos, seedOwner, installFakeRunner } from "../jobs/_harness";
import { eq } from "@repo/db";
import { securitySigningBytes, type SecurityAdvisory } from "@repo/core";
import { OpenshipClient } from "@repo/sdk/client";
import { updatesRoutes } from "../../../src/modules/updates/updates.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { scanSecurityAdvisories } from "@repo/platform/engine/modules/updates/security.service";
import { processQueuedNotifications } from "@repo/platform/engine/lib/notification-workers";

const h = vi.hoisted(() => ({
  key: "",
  probe: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/github/github.token", () => ({
  tokenFor: async () => null,
}));
vi.mock("@repo/platform/engine/modules/updates/security-signature", async (original) => {
  const real =
    await original<typeof import("@repo/platform/engine/modules/updates/security-signature")>();
  return {
    verifySecurityManifest: (proof: unknown, options: object) =>
      real.verifySecurityManifest(proof, { ...options, publicKey: h.key }),
  };
});
vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...(await original<object>()),
  resolveDeploymentRuntimeForRead: async () => ({
    runtime: {
      supports: (capability: string) => capability === "isolatedExec",
      inContainerExecutor: async () => ({ exec: h.probe }),
      dispose: async () => {},
    },
  }),
}));
vi.mock("@repo/platform/engine/modules/services/service-container", async (original) => ({
  ...(await original<object>()),
  liveContainerIdWithRuntime: async () => "fixture-container",
}));
vi.mock("@repo/platform/engine/modules/updates/runtime-update", async (original) => ({
  ...(await original<object>()),
  updateProjectRuntime: h.refresh,
}));
installFakeRunner();
afterEach(() => vi.unstubAllGlobals());

it("inspects on a newly published advisory, delivers once, and clears it only after new runtime evidence", async () => {
  const owner = await seedOwner(),
    other = await seedOwner();
  const group = await repos.projectGroup.create({
    organizationId: owner.orgId,
    name: "Advisory test",
    slug: owner.userId,
  });
  const project = await repos.project.create({
    organizationId: owner.orgId,
    groupId: group.id,
    name: "Advisory test",
    slug: owner.userId,
    framework: "docker-compose",
    runtimeMode: "docker",
    gitProvider: "upload",
  });
  const service = await repos.service.create({
    projectId: project.id,
    name: "api",
    image: "node:22-alpine",
    enabled: true,
  });
  const oldDigest = `sha256:${"a".repeat(64)}`;
  const deployed = await repos.deployment.create({
    organizationId: owner.orgId,
    projectId: project.id,
    status: "ready",
    branch: "main",
    meta: { runtimeMode: "docker" },
  });
  await repos.service.upsertServiceDeployment({
    serviceId: service.id,
    deploymentId: deployed.id,
    status: "success",
    imageRef: service.image,
    imageDigest: oldDigest,
    containerId: "fixture-container",
  });
  await repos.project.update(project.id, { activeDeploymentId: deployed.id });
  const channel = await repos.notificationChannel.create({
    userId: owner.userId,
    kind: "in_app",
    label: "Inbox",
    config: {},
    enabled: true,
    verified: true,
  });
  const foreignChannel = await repos.notificationChannel.create({
    userId: other.userId,
    kind: "in_app",
    label: "Foreign inbox",
    config: {},
    enabled: true,
    verified: true,
  });
  const keys = generateKeyPairSync("ed25519");
  h.key = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  h.probe.mockResolvedValue("OPENSHIP_RUNTIME_node\nv22.23.3\n");
  const notice: SecurityAdvisory = {
    id: "fixture-node-patch",
    revision: 1,
    severity: "high",
    title: "Patch Node.js",
    message: "The observed version requires an update.",
    url: "https://example.com/advisory",
    publishedAt: new Date().toISOString(),
    action: "refresh-images",
    targets: [{ kind: "runtime", runtime: "node", affected: "<22.23.4", fixed: ">=22.23.4" }],
  };
  let revision = Date.now();
  const envelope = (advisories: SecurityAdvisory[]) => {
    const payload = JSON.stringify({
      format: 1,
      revision: ++revision,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      advisories,
    });
    return {
      payload,
      signature: sign(null, Buffer.from(securitySigningBytes(payload)), keys.privateKey).toString(
        "base64",
      ),
    };
  };
  let proof = envelope([]);
  const requests = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (
      url.includes("api.github.com/repos/oblien/openship/contents/security-advisories.signed.json")
    )
      return Response.json(proof, { headers: { etag: `"${revision}"` } });
    if (url.endsWith("/releases/latest")) return Response.json({ tag_name: "v0.9.3" });
    if (url.endsWith("/CHANGELOG.md")) return new Response("## 0.9.3\n\nFixture release.");
    if (url.startsWith("https://raw.githubusercontent.com/oblien/openship/"))
      return Response.json({ advisories: [] });
    throw new Error(`Unexpected external request: ${url}`);
  });
  vi.stubGlobal("fetch", requests);
  const app = new Hono()
    .onError(handleApiError)
    .route("/api/health", healthRoutes)
    .route("/api/updates", updatesRoutes);
  const client = new OpenshipClient({
    baseUrl: "http://openship.test",
    token: owner.token,
    organizationId: owner.orgId,
    fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
  });
  const deliveries = () =>
    db
      .select()
      .from(schema.notificationDelivery)
      .where(eq(schema.notificationDelivery.channelId, channel.id));
  const publish = async (advisories: SecurityAdvisory[]) => {
    proof = envelope(advisories);
    // Move the scheduler's due time; production honors the normal polling cadence.
    await db
      .update(schema.advisoryFeed)
      .set({ nextCheckAt: new Date(0) })
      .where(eq(schema.advisoryFeed.id, "security"));
  };

  await scanSecurityAdvisories();
  const before = await client.updates.security(project.id);
  expect(before.findings).toEqual([]);
  expect(before.autoRefresh).toBe(false);
  expect(h.probe).not.toHaveBeenCalled();
  const inventory = await repos.securityAdvisory.project(project.id);
  expect(inventory?.inventory).toMatchObject({
    deploymentId: deployed.id,
    images: [expect.objectContaining({ ref: "node:22-alpine", digest: oldDigest })],
    runtimes: [],
  });
  expect(await deliveries()).toEqual([]);

  await publish([notice]);
  // The root banner does not execute commands while matching a new feed.
  const pending = await client.updates.advisories();
  expect(pending.overview.pendingProjects).toBe(1);
  expect(pending.overview.projects).toEqual([
    expect.objectContaining({ projectId: project.id, checkedAt: null, findings: [] }),
  ]);
  expect(h.probe).not.toHaveBeenCalled();
  await scanSecurityAdvisories();
  const global = await client.updates.advisories();
  expect(global.overview.projects).toEqual([
    expect.objectContaining({
      projectId: project.id,
      name: project.name,
      findings: [expect.objectContaining({ id: notice.id, evidence: ["node 22.23.3"] })],
    }),
  ]);
  const privateRead = await app.request("/api/updates/advisories", { headers: other.auth });
  expect((await privateRead.json()).data.overview.projects).toEqual([]);
  const affected = await client.updates.security(project.id);
  expect(affected.findings).toEqual([
    expect.objectContaining({
      id: notice.id,
      confidence: "confirmed",
      serviceId: service.id,
      evidence: ["node 22.23.3"],
    }),
  ]);
  expect(affected.checkedAt).not.toBe(before.checkedAt);
  expect(h.probe).toHaveBeenCalledOnce(); // New rules trigger one observation, then reads reuse it.
  await processQueuedNotifications();
  expect(await deliveries()).toEqual([
    expect.objectContaining({
      status: "sent",
      payload: expect.objectContaining({
        advisoryId: notice.id,
        resourceId: project.id,
        serviceName: "api",
      }),
    }),
  ]);
  expect(
    await db
      .select()
      .from(schema.notificationDelivery)
      .where(eq(schema.notificationDelivery.channelId, foreignChannel.id)),
  ).toEqual([]);
  const forbidden = await app.request(`/api/updates/${project.id}/security`, {
    headers: other.auth,
  });
  expect(forbidden.status).toBe(404);

  await Promise.all([scanSecurityAdvisories(), scanSecurityAdvisories()]);
  await publish([notice]); // Signature renewal has a new feed revision, but no new advisory.
  await scanSecurityAdvisories();
  await processQueuedNotifications();
  expect(await deliveries()).toHaveLength(1);
  expect(h.probe).toHaveBeenCalledOnce();
  expect(h.refresh).not.toHaveBeenCalled();

  await client.updates.checkSecurity(project.id);
  expect(h.probe).toHaveBeenCalledTimes(2);
  expect(await deliveries()).toHaveLength(1);
  const forbiddenCheck = await app.request(`/api/updates/${project.id}/security/check`, {
    method: "POST",
    headers: other.auth,
  });
  expect(forbiddenCheck.status).toBe(404);
  expect(h.probe).toHaveBeenCalledTimes(2);

  // Same mutable tag, different deployment and runtime: do not reuse the old evidence.
  const replacement = await repos.deployment.create({
    organizationId: owner.orgId,
    projectId: project.id,
    status: "ready",
    branch: "main",
    meta: { runtimeMode: "docker" },
  });
  await repos.service.upsertServiceDeployment({
    serviceId: service.id,
    deploymentId: replacement.id,
    status: "success",
    imageRef: service.image,
    imageDigest: `sha256:${"b".repeat(64)}`,
    containerId: "fixture-container-new",
  });
  await repos.project.update(project.id, { activeDeploymentId: replacement.id });
  h.probe.mockResolvedValue("OPENSHIP_RUNTIME_node\nv22.23.4\n");
  const patched = await client.updates.security(project.id);
  expect(patched.deploymentId).toBe(replacement.id);
  expect(patched.findings).toEqual([]);
  expect((await client.updates.advisories()).overview.projects).toEqual([
    expect.objectContaining({ projectId: project.id, findings: [], checkedAt: expect.any(String) }),
  ]);
  expect(h.probe).toHaveBeenCalledTimes(3);
  const stale = await app.request(`/api/updates/${project.id}/security/apply`, {
    method: "POST",
    headers: { ...owner.auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      advisoryId: notice.id,
      deploymentId: deployed.id,
      serviceId: service.id,
    }),
  });
  expect(stale.status).toBe(400);
  expect(h.refresh).not.toHaveBeenCalled();
  expect(requests.mock.calls.every(([url]) => String(url).includes("github"))).toBe(true);
});
