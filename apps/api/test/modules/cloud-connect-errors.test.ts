import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { db, repos, schema, seedOwner, installFakeRunner, type SeededOwner } from "./jobs/_harness";
import { cloudRuntimeTarget, env } from "@repo/platform/engine/config/env";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import { readCloudSession } from "@repo/platform/engine/lib/cloud/transport";
import { GITHUB_PROVIDER, GITLAB_PROVIDER, type ResourceType } from "@repo/core";
import { cloudLocalRoutes } from "../../src/modules/cloud/cloud-local.routes";
import { handleApiError } from "../../src/middleware/error-handler";
import { shutdownRateLimit } from "../../src/lib/rate-limit";

installFakeRunner();
const app = new Hono().onError(handleApiError).route("/api/cloud", cloudLocalRoutes);
const remote = vi.fn();
let owner: SeededOwner;
const finalize = () =>
  app.request("/api/cloud/connect-finalize", {
    method: "POST",
    headers: { ...owner.auth, "content-type": "application/json" },
    body: JSON.stringify({ code: "secret-login-code", codeVerifier: "secret-verifier" }),
  });

beforeAll(() => vi.stubEnv("OPENSHIP_RATE_LIMIT_STORE", "memory"));
afterAll(async () => {
  await shutdownRateLimit();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(async () => {
  owner = await seedOwner();
  remote.mockReset();
  vi.stubGlobal("fetch", remote);
});

describe("Cloud sign-in failure responses", () => {
  it("bounds an unresponsive code exchange and preserves the actionable timeout response", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    remote.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        }),
    );
    const pending = finalize();
    await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(1));
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(remote.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    controller.abort(new DOMException("Deadline exceeded", "TimeoutError"));
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "CLOUD_CONNECTION_TIMEOUT",
      error: expect.stringContaining("did not respond in time"),
    });
  });

  it("reports network failure without leaking the code or verifier", async () => {
    remote.mockRejectedValue(
      new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }),
    );
    const response = await finalize();
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      code: "CLOUD_CONNECTION_UNAVAILABLE",
      error: expect.stringContaining("Could not reach"),
    });
    expect(body).not.toContain("secret-login-code");
    expect(body).not.toContain("secret-verifier");
  });

  it.each([429, 503])(
    "does not label Cloud unavailability as a rejected login (HTTP %s)",
    async (status) => {
      remote.mockResolvedValue(new Response("unavailable", { status }));
      const response = await finalize();
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "CLOUD_CONNECTION_UNAVAILABLE" });
    },
  );

  it("retains rejection of an invalid or used authorization code", async () => {
    remote.mockResolvedValue(new Response("invalid code", { status: 401 }));
    expect((await finalize()).status).toBe(401);
    expect(remote).toHaveBeenCalledTimes(1);
  });
});

describe("Cloud disconnect and repository grants", () => {
  const github = GITHUB_PROVIDER.grantTypes;
  const gitlab = GITLAB_PROVIDER.grantTypes;
  const disconnect = () => app.request("/api/cloud/disconnect", { method: "POST", headers: owner.auth });
  const grant = (resourceType: ResourceType, resourceId: string, workspace = owner) =>
    repos.resourceGrant.upsert({ organizationId: workspace.orgId, userId: workspace.userId,
      resourceType, resourceId, permissions: ["read"], grantedByUserId: workspace.userId });
  const grantIds = async (workspace = owner) =>
    (await repos.resourceGrant.listByMember(workspace.orgId, workspace.userId)).map(row => row.id).sort();
  const link = () => repos.settings.setCloudSession(owner.userId, encrypt(JSON.stringify({
    token: "test-link", userId: "cloud-owner", organizationId: "cloud-org", apiUrl: cloudRuntimeTarget.api,
  })));

  it("retains only independently connected namespaces and isolates other providers and workspaces", async () => {
    await link();
    const sourceId = `app-${owner.orgId}`;
    await db.insert(schema.gitSource).values({
      id: sourceId, organizationId: owner.orgId, name: "Local App", appId: 42, slug: "local-app",
      webhookUrl: "https://example.test/hook", secretsEnc: "unused",
    });
    const installation = { userId: owner.userId, organizationId: owner.orgId, provider: "github" };
    await repos.gitInstallation.upsert({ ...installation, owner: "local", installationId: 1, sourceId });
    await repos.gitInstallation.upsert({ ...installation, owner: "hosted", installationId: 2 });
    const localNamespace = await grant(github.namespace, "LOCAL");
    const localRepo = await grant(github.repository, "Local/App");
    const gitlabRepo = await grant(gitlab.repository, "hosted/app");
    await grant(github.root, "*");
    await grant(github.repository, "*");
    await grant(github.repository, "local-extra/app");
    await grant(github.namespace, "hosted");
    const other = await seedOwner();
    const otherGrant = await grant(github.root, "*", other);
    // This user is also an owner here, but another owner's link supplies this workspace.
    await repos.settings.setCloudSession(other.userId, "independently-linked");
    await db.insert(schema.member).values({
      id: `secondary-${owner.orgId}`, userId: owner.userId, organizationId: other.orgId, role: "owner",
      createdAt: new Date(Date.now() + 60_000),
    });
    remote.mockResolvedValue(Response.json({ ok: true }));

    const response = await disconnect();
    expect(response.status, await response.text()).toBe(200);
    expect(await readCloudSession(owner.userId)).toBeNull();
    expect(await grantIds()).toEqual([localNamespace.id, localRepo.id, gitlabRepo.id].sort());
    expect(await grantIds(other)).toEqual([otherGrant.id]);

    const later = await grant(github.root, "*");
    expect((await disconnect()).status).toBe(200);
    expect(await grantIds()).toContain(later.id);
  });

  it("keeps grants when GitHub uses an explicitly configured local authority", async () => {
    const prior = env.GITHUB_AUTH_MODE;
    env.GITHUB_AUTH_MODE = "token";
    try {
      await link();
      const existing = await grant(github.root, "*");
      remote.mockResolvedValue(Response.json({ ok: true }));
      expect((await disconnect()).status).toBe(200);
      expect(await grantIds()).toEqual([existing.id]);
    } finally {
      env.GITHUB_AUTH_MODE = prior;
    }
  });

  it("reconciles the same grants when Cloud reports that the session expired", async () => {
    await link();
    await grant(github.root, "*");
    const existing = await grant(gitlab.root, "*");
    remote.mockResolvedValue(new Response(null, { status: 401 }));
    const response = await app.request("/api/cloud/status", { headers: owner.auth });
    expect(await response.json()).toMatchObject({ connected: false });
    expect(await readCloudSession(owner.userId)).toBeNull();
    expect(await grantIds()).toEqual([existing.id]);
  });

  it("keeps the link and grants together if cleanup fails, then retries", async () => {
    await link();
    const existing = await grant(github.root, "*");
    const providers = await import("@repo/platform/engine/modules/git/provider");
    const revoke = providers.revokeCloudGitGrants;
    vi.spyOn(providers, "revokeCloudGitGrants").mockImplementationOnce(async (tx, orgId) => {
      await revoke(tx, orgId);
      throw new Error("test cleanup failure");
    });
    remote.mockImplementation(async () => Response.json({ ok: true }));
    expect((await disconnect()).status).toBe(500);
    expect(await readCloudSession(owner.userId)).toBeTruthy();
    expect(await grantIds()).toEqual([existing.id]);
    expect((await disconnect()).status).toBe(200);
    expect(await grantIds()).toEqual([]);
  });
});
