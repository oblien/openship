import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
// Keep all storage, permissions, encryption, readers and detection real. Only
// the external GitHub API and the host's ambient gh identity are replaced.
vi.mock("@repo/platform/engine/modules/github/github.local-auth", () => ({
  getLocalGhToken: async () => null,
}));
import {
  db,
  repos,
  schema,
  seedOwner,
  seedServer,
  installFakeRunner,
  type SeededOwner,
} from "../jobs/_harness";
import { eq } from "@repo/db";
import { env } from "@repo/platform/engine/config/env";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";
import { buildDependencies } from "@repo/platform/engine/modules/deployments/build.operations";
import { resolveBuildGitToken } from "@repo/platform/engine/modules/github/clone-auth";
import { OpenshipClient } from "@repo/sdk/client";
import { githubRoutes } from "../../../src/modules/github/github.routes";
import { deploymentRoutes } from "../../../src/modules/deployments/deployment.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  .route("/api/deployments", deploymentRoutes)
  .route("/api/github", githubRoutes);
const origin = "https://openship.test";
const pat = "test-server-only-pat-never-returned";
const files: Record<string, string> = {
  "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }),
  "apps/web/package.json": JSON.stringify({ name: "web", scripts: { start: "node server.js" } }),
  "apps/api/package.json": JSON.stringify({ name: "api", scripts: { start: "node index.js" } }),
};
let owner: SeededOwner;
let serverId: string;
let requests: { path: string; token: string | null }[];
let rejectAccount: boolean;
let providerStatus: number;

beforeEach(async () => {
  env.CLOUD_MODE = false;
  owner = await seedOwner();
  serverId = await seedServer(owner.orgId);
  await db.update(schema.servers).set({ isLocal: true }).where(eq(schema.servers.id, serverId));
  await repos.serverGithubAuth.upsert({
    serverId,
    organizationId: owner.orgId,
    mode: "token",
    tokenEncrypted: encrypt(pat),
    tokenSource: "pat",
  });
  requests = [];
  rejectAccount = false;
  providerStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.origin === origin) return app.request(req);
      if (url.origin !== "https://api.github.com")
        throw new Error(`Unexpected network destination ${url.origin}`);
      const token = req.headers.get("authorization");
      requests.push({ path: url.pathname, token });
      if (rejectAccount && token === "Bearer rejected-account-pat")
        return Response.json(
          { message: "Resource not accessible by personal access token" },
          { status: 403 },
        );
      if (token !== `Bearer ${pat}`)
        return Response.json({ message: "Not Found" }, { status: 404 });
      if (providerStatus !== 200)
        return Response.json({ message: "Provider unavailable" }, { status: providerStatus });
      const prefix = "/repos/acme/private-workspace";
      if (url.pathname === prefix)
        return Response.json({
          id: 42,
          name: "private-workspace",
          owner: { login: "acme" },
          default_branch: "main",
          private: true,
        });
      if (url.pathname === `${prefix}/branches`)
        return Response.json([
          {
            name: "main",
            commit: { sha: "a".repeat(40), url: `${prefix}/commits/main` },
            protected: false,
          },
        ]);
      if (url.pathname.startsWith(`${prefix}/commits/`))
        return Response.json({ sha: "a".repeat(40), commit: { message: "Initial" } });
      if (url.pathname.startsWith(`${prefix}/git/trees/`))
        return Response.json({
          truncated: false,
          tree: Object.keys(files).map((path) => ({ path, type: "blob" })),
        });
      if (url.pathname.startsWith(`${prefix}/contents/`)) {
        const path = decodeURIComponent(url.pathname.slice(`${prefix}/contents/`.length));
        if (files[path])
          return Response.json({
            sha: "a".repeat(40),
            content: Buffer.from(files[path]).toString("base64"),
            size: files[path].length,
          });
        const children = new Map<string, { name: string; path: string; type: string }>();
        for (const file of Object.keys(files)) {
          const relative = path
            ? file.startsWith(`${path}/`)
              ? file.slice(path.length + 1)
              : null
            : file;
          if (!relative) continue;
          const name = relative.split("/")[0]!;
          children.set(name, {
            name,
            path: path ? `${path}/${name}` : name,
            type: relative.includes("/") ? "dir" : "file",
          });
        }
        if (children.size) return Response.json([...children.values()]);
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    }),
  );
});
afterEach(() => {
  env.CLOUD_MODE = false;
  vi.unstubAllGlobals();
});
function client() {
  return new OpenshipClient({ baseUrl: `${origin}/api`, token: owner.token });
}
const source = {
  source: "github" as const,
  owner: "acme",
  repo: "private-workspace",
  branch: "main",
};

describe("server PAT-only preparation through the real authenticated HTTP/SDK flow (#1500)", () => {
  it.each([false, true])(
    "detects the monorepo and sub-app using the same credential as deploy (explicit server=%s)",
    async (explicit) => {
      const scan = await client().deployments.prepare({
        ...source,
        ...(explicit ? { serverId } : {}),
      });
      expect(scan.projectType).toBe("monorepo");
      expect(scan.monorepoApps?.map((app) => app.rootDirectory)).toEqual(
        expect.arrayContaining(["apps/web", "apps/api"]),
      );
      const folder = await client().deployments.prepare({
        ...source,
        serverId,
        rootDirectory: "apps/web",
      });
      expect(folder.rootDirectory).toBe("apps/web");
      const ctx = buildBackgroundContext({ userId: owner.userId, organizationId: owner.orgId });
      expect(
        await resolveBuildGitToken({
          ctx,
          projectId: "not-created-by-scan",
          buildStrategy: "server",
          owner: "acme",
          repo: "private-workspace",
          serverId,
        }),
      ).toMatchObject({ token: pat });
      expect(requests).toEqual(
        expect.arrayContaining([
          { path: "/repos/acme/private-workspace", token: `Bearer ${pat}` },
          { path: "/repos/acme/private-workspace/branches", token: `Bearer ${pat}` },
          { path: "/repos/acme/private-workspace/commits/main", token: `Bearer ${pat}` },
          { path: "/repos/acme/private-workspace/contents/package.json", token: `Bearer ${pat}` },
        ]),
      );
      expect(JSON.stringify(scan)).not.toContain(pat);
    },
  );
  it("keeps an explicitly selected remote server through branch and folder browsing", async () => {
    await db.update(schema.servers).set({ isLocal: false }).where(eq(schema.servers.id, serverId));
    const repo = { owner: source.owner, repo: source.repo, serverId };
    expect((await client().deployments.prepare({ ...source, serverId })).projectType).toBe(
      "monorepo",
    );
    expect((await client().github.listBranches(repo)).data[0]?.name).toBe("main");
    expect(await client().github.listTree({ ...repo, branch: "main" })).toContainEqual({
      path: "apps/web/package.json",
      type: "file",
    });
    expect(requests.every((req) => req.token === `Bearer ${pat}`)).toBe(true);
  });
  it("retries a rejected account credential through the same chain", async () => {
    rejectAccount = true;
    await repos.settings.upsert({
      id: crypto.randomUUID(),
      userId: owner.userId,
      cloneTokenEncrypted: encrypt("rejected-account-pat"),
      cloneTokenAsDefault: true,
    });
    expect((await client().deployments.prepare({ ...source, serverId })).projectType).toBe(
      "monorepo",
    );
    expect(requests.some((req) => req.token === "Bearer rejected-account-pat")).toBe(true);
    expect(requests.some((req) => req.token === `Bearer ${pat}`)).toBe(true);
  });
  it.each([
    { owner: "..", repo: "user" },
    { owner: "acme", repo: ".." },
    { owner: "acme/private-workspace", repo: "another" },
  ])("rejects invalid repository identities before any provider request: %j", async (target) => {
    const result = await app.request(`${origin}/api/deployments/prepare`, {
      method: "POST",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ ...source, ...target, serverId }),
    });
    expect(result.status).toBe(400);
    expect(requests).toHaveLength(0);
    expect(await result.text()).not.toContain(pat);
  });

  it("never borrows another organization's server token", async () => {
    const foreign = await seedOwner();
    const foreignId = await seedServer(foreign.orgId);
    await expect(
      client().deployments.prepare({ ...source, serverId: foreignId }),
    ).rejects.toMatchObject({ status: 404 });
    expect(requests).toHaveLength(0);
  });
  it("never searches another connected server when there is no local default", async () => {
    await db.update(schema.servers).set({ isLocal: false }).where(eq(schema.servers.id, serverId));
    await expect(client().deployments.prepare(source)).rejects.toMatchObject({ status: 403 });
    expect(requests.every((req) => req.token !== `Bearer ${pat}`)).toBe(true);
  });
  it("requires server write permission in addition to repository access", async () => {
    const member = await repos.member.find(owner.orgId, owner.userId);
    await db
      .update(schema.member)
      .set({ role: "restricted" })
      .where(eq(schema.member.id, member!.id));
    await db.insert(schema.resourceGrant).values({
      id: crypto.randomUUID(),
      organizationId: owner.orgId,
      userId: owner.userId,
      resourceType: "github_repository",
      resourceId: "acme/private-workspace",
      permissionsJson: '["read"]',
    });
    const ctx = buildBackgroundContext({
      userId: owner.userId,
      organizationId: owner.orgId,
      role: "restricted",
    });
    await expect(buildDependencies.prepare(ctx, { ...source, serverId })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(requests.every((req) => req.token !== `Bearer ${pat}`)).toBe(true);
    await db.insert(schema.resourceGrant).values({
      id: crypto.randomUUID(),
      organizationId: owner.orgId,
      userId: owner.userId,
      resourceType: "server",
      resourceId: serverId,
      permissionsJson: '["write"]',
    });
    expect((await buildDependencies.prepare(ctx, { ...source, serverId })).projectType).toBe(
      "monorepo",
    );
    requests = [];
    // Metadata/deployment permission cannot reveal editable source env values.
    await expect(
      buildDependencies.prepare(ctx, { ...source, serverId, includeEnv: true }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(requests).toHaveLength(0);
  });
  it("leaves Cloud's account-only authentication unchanged", async () => {
    env.CLOUD_MODE = true;
    await expect(client().deployments.prepare({ ...source, serverId })).rejects.toMatchObject({
      status: 403,
    });
    expect(requests.every((req) => req.token !== `Bearer ${pat}`)).toBe(true);
  });
  it.each([429, 503])("does not hide a provider %s as a successful scan", async (status) => {
    providerStatus = status;
    await expect(client().deployments.prepare({ ...source, serverId })).rejects.toThrow(
      /GitHub API error/,
    );
  });
});
