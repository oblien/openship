import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const provider = vi.hoisted(() => ({ fetch: vi.fn(), cloneToken: vi.fn(), source: vi.fn(), send: vi.fn() }));
vi.mock("@repo/platform/engine/modules/github/github.auth", async original => ({ ...await original<object>(), githubFetch: provider.fetch, getInstallationToken: provider.cloneToken }));
vi.mock("@repo/platform/engine/modules/github/sources/index", () => ({ createGitHubSource: provider.source }));
vi.mock("@repo/platform/engine/modules/github/github.http", async original => ({ ...await original<object>(), ghSend: provider.send }));
import { db, schema, repos, seedOwner, seedServer, installFakeRunner, type SeededOwner } from "../jobs/_harness";
import { createShip, type VerifiedIdentity } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { githubRoutes } from "../../../src/modules/github/github.routes";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { systemRoutes } from "../../../src/modules/system/system.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import { setStoredDeviceToken } from "@repo/platform/engine/modules/github/github.local-auth";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { eq } from "@repo/db";
installFakeRunner();
const app = new Hono().onError(handleApiError).route("/api/health", healthRoutes).route("/api/github", githubRoutes).route("/api/system", systemRoutes).route("/api/projects", projectRoutes);
async function clients(actor: SeededOwner, organizationId = actor.orgId, limits: Partial<VerifiedIdentity> = {}) {
  const user = (await repos.user.findById(actor.userId))!;
  const ship = createShip({ platform: getPlatformKernel(), identity: { resolve: async () => ({ user, sessionId: "git-test", ...limits }) } });
  return {
    native: await ship.scope({ identity: "verified", organizationId }),
    remote: new OpenshipClient({ baseUrl: "http://openship.test", token: actor.token, organizationId, fetch: ((url, init) => app.request(url as string, init)) as typeof fetch }),
  };
}
async function memberOf(owner: SeededOwner) {
  const member = await seedOwner({ bound: false });
  await db.insert(schema.member).values({ id: `git_${member.userId}`, organizationId: owner.orgId, userId: member.userId, role: "restricted" });
  await repos.resourceGrant.upsert({ organizationId: owner.orgId, userId: member.userId, resourceType: "github_repository", resourceId: "acme/app", permissions: ["read"], scope: { v: 1, read: { paths: ["src/**"] } }, grantedByUserId: owner.userId });
  return member;
}
const detail = { id: 1, name: "app", full_name: "acme/app", owner: { login: "acme", id: 1, avatar_url: "" }, private: true, default_branch: "main", clone_url: "https://github.com/acme/app.git", ssh_url: "git@github.com:acme/app.git", html_url: "https://github.com/acme/app" };
const mapped = (name: string) => ({ ...detail, owner: "acme", name, full_name: `acme/${name}`, description: null, visibility: "private", language: null, size: 1, forks: 0, watchers: 0, stars: 0, license: null, created_at: "2026-01-01", updated_at: "2026-01-01", pushed_at: "2026-01-01" });
const entry = (path: string, type = "file") => ({ name: path.split("/").pop(), path, sha: "abc", size: 5, type, download_url: null });
afterEach(async () => { vi.clearAllMocks(); await setStoredDeviceToken(null); });

describe("GitHub operations shared by SDK and HTTP", () => {
  it("returns branch pagination through native operations and HTTP without truncating later pages", async () => {
    const c = await clients(await seedOwner());
    const branch = { name: "main", commit: { sha: "abc", url: "https://api.github.com/commit/abc" }, protected: false };
    provider.fetch.mockResolvedValue([branch]);
    for (const client of [c.native, c.remote]) {
      expect(await client.github.listBranches({ owner: "acme", repo: "app", page: 2 })).toEqual({
        data: [branch],
        pagination: { page: 2, perPage: 100, hasMore: false },
      });
      expect(provider.fetch.mock.lastCall?.[0].params).toEqual({ page: 2, per_page: 100 });
      await expect(client.github.listBranches({ owner: "acme", repo: "app", page: -1 })).rejects.toBeDefined();
    }
  });

  it("preserves page metadata and project authorization for linked-repository branch lists", async () => {
    const owner = await seedOwner();
    const c = await clients(owner);
    const group = await repos.projectGroup.create({ organizationId: owner.orgId, name: "Branches", slug: `branches-${owner.userId}` });
    const project = await repos.project.create({ organizationId: owner.orgId, groupId: group.id, name: "Branches", slug: `branches-${owner.userId}`, gitOwner: "acme", gitRepo: "app", gitProvider: "github" });
    const other = await clients(await seedOwner());
    provider.fetch.mockResolvedValue([{ name: "main", commit: { sha: "abc", url: "https://api.github.com/commit/abc" }, protected: false }]);
    for (const client of [c.native, c.remote]) {
      expect(await client.projects.listBranches(project.id, { page: 2 })).toMatchObject({
        data: [{ name: "main", sha: "abc", protected: false }],
        pagination: { page: 2, perPage: 100, hasMore: false },
      });
    }
    const calls = provider.fetch.mock.calls.length;
    for (const client of [other.native, other.remote]) {
      await expect(client.projects.listBranches(project.id, { page: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(provider.fetch).toHaveBeenCalledTimes(calls);
  });

  it("preserves repository presentation and limits installation tokens to the requested repository", async () => {
    const c = await clients(await seedOwner());
    provider.fetch.mockResolvedValue(detail);
    provider.cloneToken.mockResolvedValue("repo-only-token");
    for (const client of [c.native, c.remote]) {
      expect(await client.github.getRepo({ owner: "acme", repo: "app" })).toMatchObject({ name: "app", owner: "acme", private: true });
      expect(await client.github.getCloneToken({ owner: "acme", repo: "app" })).toMatchObject({ token: "repo-only-token", cloneUrl: "https://x-access-token:repo-only-token@github.com/acme/app.git" });
    }
    for (const call of provider.cloneToken.mock.calls) expect(call.slice(1)).toEqual(["acme", undefined, { repositories: ["app"] }]);
  });

  it("saves a scanned branch and build settings together through native and HTTP project operations", async () => {
    const owner = await seedOwner();
    const c = await clients(owner);
    const group = await repos.projectGroup.create({ organizationId: owner.orgId, name: "Scan", slug: `scan-${owner.userId}` });
    const project = await repos.project.create({ organizationId: owner.orgId, groupId: group.id, name: "Scan", slug: `scan-${owner.userId}`, gitOwner: "acme", gitRepo: "app", gitProvider: "github", gitBranch: "main", composePath: "old/compose.yml" });
    for (const client of [c.native, c.remote]) {
      await client.projects.setOptions(project.id, { gitBranch: "plain", framework: "node", buildCommand: "npm run build", composePath: null });
      expect(await repos.project.findById(project.id)).toMatchObject({ gitBranch: "plain", framework: "node", buildCommand: "npm run build", composePath: null });
      await expect(client.projects.setOptions(project.id, { gitBranch: " ", buildCommand: "invalid update" })).rejects.toMatchObject({ statusCode: 400 });
      expect((await repos.project.findById(project.id))?.buildCommand).toBe("npm run build");
    }
  });

  it("filters repository counts and directory entries before returning them to a restricted principal", async () => {
    const owner = await seedOwner(), member = await memberOf(owner), c = await clients(member, owner.orgId);
    provider.source.mockResolvedValue({ listReposForOwner: async () => [mapped("app"), mapped("hidden")] });
    provider.fetch.mockResolvedValue([entry("src", "dir"), entry(".env")]);
    for (const client of [c.native, c.remote]) {
      const list = await client.github.listOrgRepos({ org: "acme", perPage: 1 });
      expect(list).toMatchObject({ count: 1, total: 1, privateCount: 1, publicCount: 0 });
      expect(list.data.map(repo => repo.name)).toEqual(["app"]);
      expect(await client.github.listFiles({ owner: "acme", repo: "app" })).toEqual([entry("src", "dir")]);
      const before = provider.fetch.mock.calls.length;
      await expect(client.github.getFile({ owner: "acme", repo: "app", file: ".env" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.github.getRepo({ owner: "acme", repo: "hidden" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.github.getCloneToken({ owner: "acme", repo: "app" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(provider.fetch.mock.calls).toHaveLength(before);
    }
    expect(provider.cloneToken).not.toHaveBeenCalled();
  });

  it("uses the authorized file path for provider reads, including literal URL punctuation and percent escapes", async () => {
    const owner = await seedOwner(), member = await memberOf(owner), c = await clients(member, owner.orgId);
    provider.fetch.mockResolvedValue({ ...entry("src/main.ts"), content: Buffer.from("source").toString("base64") });
    for (const client of [c.native, c.remote]) {
      expect((await client.github.getFile({ owner: "acme", repo: "app", file: "src/./main.ts" })).content).toBe("source");
      expect(provider.fetch.mock.lastCall?.[0].url.endsWith("/contents/src/main.ts")).toBe(true);
      await client.github.getFile({ owner: "acme", repo: "app", file: "src/%2e%2e/secrets#?.ts" });
      expect(provider.fetch.mock.lastCall?.[0].url.endsWith("/contents/src/%252e%252e/secrets%23%3F.ts")).toBe(true);
      await expect(client.github.getFile({ owner: "acme", repo: "app", file: "src/../.env" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("denies content disguised as a directory, and applies read-only credential limits before provider mutations", async () => {
    const owner = await seedOwner(), member = await memberOf(owner), c = await clients(member, owner.orgId);
    provider.fetch.mockResolvedValue(entry(".env"));
    for (const client of [c.native, c.remote]) await expect(client.github.listFiles({ owner: "acme", repo: "app" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const readonly = await clients(owner, owner.orgId, { credential: { organizationId: owner.orgId, readOnly: true } });
    await expect(readonly.native.github.createRepo({ name: "blocked" })).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    await expect(readonly.native.github.disconnect({ source: "oauth" })).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
  });

  it("keeps Git source secrets and identifiers confined to their tenant and owner", async () => {
    const owner = await seedOwner(), other = await seedOwner(), member = await memberOf(owner), c = await clients(owner);
    const makeSource = (organizationId: string, appId: number) => repos.gitSource.create({ organizationId, name: `app-${appId}`, appId, slug: `app-${appId}`, webhookUrl: "https://hooks.example.test/github", secretsEnc: encrypt(JSON.stringify({ privateKeyPem: "private-key", webhookSecret: "webhook-secret" })) });
    const source = await makeSource(owner.orgId, 1), foreign = await makeSource(other.orgId, 2);
    for (const client of [c.native, c.remote]) {
      const list = await client.github.listSources();
      expect(list.data.map(row => row.id)).toEqual([source.id]);
      expect(JSON.stringify(list)).not.toContain("private-key");
      expect(JSON.stringify(list)).not.toContain("secretsEnc");
      await expect(client.github.setDefaultSource(foreign.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    const restricted = await clients(member, owner.orgId);
    for (const client of [restricted.native, restricted.remote]) await expect(client.github.listSources()).rejects.toMatchObject({ code: "ORG_OWNER_REQUIRED" });
  });

  it("requires instance authority for global credentials and never exposes them in results or audit", async () => {
    const owner = await seedOwner(), c = await clients(owner);
    for (const client of [c.native, c.remote]) await expect(client.github.setInstanceToken({ token: "secret" })).rejects.toMatchObject({ statusCode: 403 });
    expect(provider.send).not.toHaveBeenCalled();
    const admin = await seedOwner({ instanceAdmin: true }), adminClients = await clients(admin);
    provider.send.mockImplementation(async () => new Response(JSON.stringify({ login: "operator" }), { headers: { "x-oauth-scopes": "repo, read:org", "Content-Type": "application/json" } }));
    for (const client of [adminClients.native, adminClients.remote]) {
      expect(await client.github.setInstanceToken({ token: "instance-private-token" })).toEqual({ connected: true, login: "operator" });
      expect(await client.github.pollConnect()).toEqual({ status: "none" });
    }
    expect((await repos.instanceSettings.get())?.ghDeviceTokenEncrypted).not.toContain("instance-private-token");
    await flushAudit();
    const events = await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.organizationId, admin.orgId));
    expect(events.filter(row => row.eventType === "github.instance_token.set")).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("instance-private-token");
  });

  it("shares persisted per-server Git configuration and enforces server ownership in both interfaces", async () => {
    const owner = await seedOwner(), other = await seedOwner(), server = await seedServer(owner.orgId), foreign = await seedServer(other.orgId), c = await clients(owner);
    expect(await c.native.servers.githubStatus(server)).toEqual({ mode: null, connected: false, deployKeyCount: 0 });
    await c.remote.servers.useGitHubDeployKeys(server);
    expect(await c.native.servers.githubStatus(server)).toMatchObject({ mode: "ssh-deploy-key", connected: false });
    for (const client of [c.native, c.remote]) await expect(client.servers.githubStatus(foreign)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await c.native.servers.disconnectGitHub(server);
    expect(await c.remote.servers.githubStatus(server)).toEqual({ mode: null, connected: false, deployKeyCount: 0 });
  });
});
