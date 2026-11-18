import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
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
import { encryptSecretField } from "@repo/platform/engine/lib/credential-encryption";
import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";
import { buildDependencies } from "@repo/platform/engine/modules/deployments/build.operations";
import { resolveBuildGitToken } from "@repo/platform/engine/modules/github/clone-auth";
import {
  githubFetch,
  type GitHubFetchOptions,
} from "@repo/platform/engine/modules/github/github.auth";
import { OpenshipClient } from "@repo/sdk/client";
import { parseDeploySource } from "@repo/core";
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
const appPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
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
let publicReadAllowed: boolean;
let appMintStatus: number;
let appReadStatus: number;

beforeEach(async () => {
  env.CLOUD_MODE = false;
  owner = await seedOwner();
  serverId = await seedServer(owner.orgId);
  await db.update(schema.servers).set({ isLocal: true }).where(eq(schema.servers.id, serverId));
  await setServerPat(serverId);
  requests = [];
  rejectAccount = false;
  providerStatus = 200;
  publicReadAllowed = false;
  appMintStatus = 403;
  appReadStatus = 403;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.origin === origin) return app.request(req);
      if (url.origin !== "https://api.github.com" && url.origin !== "https://github.internal.test")
        throw new Error(`Unexpected network destination ${url.origin}`);
      const token = req.headers.get("authorization");
      requests.push({ path: url.pathname, token });
      if (url.pathname.endsWith("/app/installations/42/access_tokens"))
        return appMintStatus === 201
          ? Response.json(
              {
                token: "custom-app-token",
                expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              },
              { status: 201 },
            )
          : Response.json(
              { message: "Resource not accessible by integration" },
              { status: appMintStatus },
            );
      if (token === "Bearer custom-app-token" && appReadStatus !== 200)
        return Response.json(
          { message: "Resource not accessible by integration" },
          { status: appReadStatus },
        );
      if (rejectAccount && token === "Bearer rejected-account-pat")
        return Response.json(
          { message: "Resource not accessible by personal access token" },
          { status: 403 },
        );
      if (
        token !== `Bearer ${pat}` &&
        token !== "Bearer custom-app-token" &&
        !(publicReadAllowed && token === null)
      )
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
          private: !publicReadAllowed,
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

async function setServerPat(id: string, token = pat) {
  await repos.serverGithubAuth.upsert({
    serverId: id,
    organizationId: owner.orgId,
    mode: "token",
    tokenEncrypted: encrypt(token),
    tokenSource: "pat",
  });
}

async function addConnectedServerWithPat() {
  const id = await seedServer(owner.orgId, "connected-deploy");
  await setServerPat(id);
  return id;
}

async function addOtherServerToken() {
  const id = await seedServer(owner.orgId, "other-repository");
  await db
    .update(schema.servers)
    .set({ createdAt: new Date("2000-01-01T00:00:00Z") })
    .where(eq(schema.servers.id, id));
  await setServerPat(id, "unrelated-repository-pat");
  return id;
}

async function addCustomApp(apiBaseUrl = "https://api.github.com") {
  const appSource = await repos.gitSource.create({
    organizationId: owner.orgId,
    name: "Workspace GitHub App",
    appId: 9,
    slug: "workspace-app",
    apiBaseUrl,
    webhookUrl: "https://openship.test/api/github/webhook",
    secretsEnc: encryptSecretField(
      JSON.stringify({ privateKeyPem: appPrivateKey, webhookSecret: "test-webhook-secret" }),
    )!,
  });
  await repos.gitInstallation.upsert({
    userId: owner.userId,
    organizationId: owner.orgId,
    sourceId: appSource.id,
    owner: source.owner,
    installationId: 42,
  });
}

describe("server PAT-only preparation through the real authenticated HTTP/SDK flow (#1500)", () => {
  it.each([
    { explicit: false, mintStatus: 403 },
    { explicit: true, mintStatus: 403 },
    { explicit: false, mintStatus: 201 },
    { explicit: true, mintStatus: 201 },
  ])(
    "scans through the SSH server PAT when its github.com App cannot read the repo (#1814): %j",
    async ({ explicit, mintStatus }) => {
      await db
        .update(schema.servers)
        .set({ isLocal: false })
        .where(eq(schema.servers.id, serverId));
      const foreign = await seedOwner();
      const foreignServer = await seedServer(foreign.orgId);
      await db
        .update(schema.servers)
        .set({ isLocal: true })
        .where(eq(schema.servers.id, foreignServer));
      await addCustomApp();
      appMintStatus = mintStatus;

      const scan = await client().deployments.prepare({
        ...source,
        ...(explicit ? { serverId } : {}),
      });
      expect(scan.projectType).toBe("monorepo");
      expect(scan.monorepoApps?.map((app) => app.rootDirectory)).toEqual(
        expect.arrayContaining(["apps/web", "apps/api"]),
      );
      expect(requests).toEqual(
        expect.arrayContaining([
          { path: "/repos/acme/private-workspace", token: `Bearer ${pat}` },
          { path: "/repos/acme/private-workspace/branches", token: `Bearer ${pat}` },
          { path: "/repos/acme/private-workspace/contents/package.json", token: `Bearer ${pat}` },
        ]),
      );
      expect(JSON.stringify(scan)).not.toContain(pat);
      expect(JSON.stringify(scan)).not.toContain(appPrivateKey);
    },
  );
  it("keeps a working github.com App ahead of the server PAT", async () => {
    await addCustomApp();
    appMintStatus = 201;
    appReadStatus = 200;
    expect((await client().deployments.prepare({ ...source, serverId })).projectType).toBe(
      "monorepo",
    );
    expect(requests.filter((req) => req.path.startsWith("/repos/"))).toEqual(
      expect.arrayContaining([
        { path: "/repos/acme/private-workspace", token: "Bearer custom-app-token" },
      ]),
    );
    expect(requests.every((req) => req.token !== `Bearer ${pat}`)).toBe(true);
  });
  it("keeps Enterprise repositories on their own source when its App fails", async () => {
    await addCustomApp("https://github.internal.test/api/v3");
    publicReadAllowed = true;
    await expect(client().deployments.prepare({ ...source, serverId })).rejects.toMatchObject({
      status: 403,
      body: { code: "GITHUB_TOKEN_REQUIRED" },
    });
    expect(requests).toEqual([
      { path: "/api/v3/app/installations/42/access_tokens", token: expect.any(String) },
    ]);
    expect(requests[0]?.token).not.toBe(`Bearer ${pat}`);
  });
  it.each([429, 503])(
    "does not fall back to a server PAT during an App %s failure",
    async (status) => {
      await addCustomApp();
      appMintStatus = status;
      await expect(client().deployments.prepare({ ...source, serverId })).rejects.toThrow(
        `GitHub App API error (${status})`,
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.path).toBe("/app/installations/42/access_tokens");
      expect(requests[0]?.token).not.toBe(`Bearer ${pat}`);
    },
  );
  it.each([
    { credential: ["app-installation"] },
    { method: "POST", authorizeAs: "read" },
    { method: "DELETE" },
    { authorizeAs: "write" },
    { url: "https://api.github.com/user" },
    { url: "https://api.github.com/repos/acme/another-repo" },
  ] satisfies Partial<GitHubFetchOptions>[])(
    "keeps the App credential boundary for %j",
    async (options) => {
      await addCustomApp();
      const ctx = buildBackgroundContext({ userId: owner.userId, organizationId: owner.orgId });
      await expect(
        githubFetch({
          ctx,
          owner: source.owner,
          repo: source.repo,
          serverId,
          url: "https://api.github.com/repos/acme/private-workspace",
          ...options,
        }),
      ).rejects.toMatchObject({ statusCode: 403, code: "GITHUB_TOKEN_REQUIRED" });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.path).toBe("/app/installations/42/access_tokens");
      expect(requests[0]?.token).not.toBe(`Bearer ${pat}`);
    },
  );
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
  it("falls back to a writable connected server with a stored credential when there is no local default (#1630)", async () => {
    await db.update(schema.servers).set({ isLocal: false }).where(eq(schema.servers.id, serverId));
    const scan = await client().deployments.prepare(source);
    expect(scan.projectType).toBe("monorepo");
    expect(scan.monorepoApps?.map((app) => app.rootDirectory)).toEqual(
      expect.arrayContaining(["apps/web", "apps/api"]),
    );
    expect(requests.some((req) => req.token === `Bearer ${pat}`)).toBe(true);
  });
  it("falls back to the connected server when the local row holds no usable GitHub credential (#1814)", async () => {
    // A self-hosted boot registers the "This Server" row whether or not GitHub
    // was ever connected on it; the org's PAT lives on the connected server.
    await repos.serverGithubAuth.deleteByServer(serverId);
    const connectedId = await addConnectedServerWithPat();
    // Naming the credential-holding server explicitly resolves it the same way.
    expect(
      (await client().deployments.prepare({ ...source, serverId: connectedId })).projectType,
    ).toBe("monorepo");
    expect(requests.every((req) => req.token === `Bearer ${pat}`)).toBe(true);
    requests = [];
    const scan = await client().deployments.prepare(source);
    expect(scan.projectType).toBe("monorepo");
    expect(requests.some((req) => req.token === `Bearer ${pat}`)).toBe(true);
  });
  it("reads through the connected server when the local row's only credential is SSH (#1814)", async () => {
    // Repository REST reads are token-only; a local row holding just SSH
    // material can clone for deploys but cannot answer an api.github.com read.
    await repos.serverGithubAuth.upsert({
      serverId,
      organizationId: owner.orgId,
      mode: "ssh-server-key",
      serverKeyPrivateEncrypted: encrypt("ssh-private-key-material"),
      serverKeyPublic: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAtest",
    });
    await addConnectedServerWithPat();
    expect((await client().deployments.prepare(source)).projectType).toBe("monorepo");
    expect(requests.some((req) => req.token === `Bearer ${pat}`)).toBe(true);
    expect(requests.every((req) => req.token !== "ssh-private-key-material")).toBe(true);
  });
  it("requires a selection when a credential-less local row hides several eligible servers (#1814)", async () => {
    await repos.serverGithubAuth.deleteByServer(serverId);
    await addOtherServerToken();
    await addConnectedServerWithPat();
    await expect(client().deployments.prepare(source)).rejects.toMatchObject({
      status: 409,
      body: { code: "GITHUB_SERVER_SELECTION_REQUIRED" },
    });
    expect(requests.every((request) => request.token === null)).toBe(true);
  });
  it("still reports GITHUB_TOKEN_REQUIRED when the credential-less local row is the only server (#1814)", async () => {
    await repos.serverGithubAuth.deleteByServer(serverId);
    await expect(client().deployments.prepare(source)).rejects.toMatchObject({
      status: 403,
      body: { code: "GITHUB_TOKEN_REQUIRED" },
    });
    expect(requests.every((req) => req.token !== `Bearer ${pat}`)).toBe(true);
  });
  it("uses the sole writable connected server when the local PAT is out of scope", async () => {
    await setServerPat(serverId, "local-server-pat");
    const connectedId = await addConnectedServerWithPat();
    const member = await repos.member.find(owner.orgId, owner.userId);
    await db
      .update(schema.member)
      .set({ role: "restricted" })
      .where(eq(schema.member.id, member!.id));
    await db.insert(schema.resourceGrant).values(
      [
        {
          resourceType: "github_repository",
          resourceId: "acme/private-workspace",
          permissionsJson: '["read"]',
        },
        { resourceType: "server", resourceId: connectedId, permissionsJson: '["write"]' },
        { resourceType: "deployment", resourceId: "*", permissionsJson: '["read", "write"]' },
      ].map((grant) => ({
        ...grant,
        id: crypto.randomUUID(),
        organizationId: owner.orgId,
        userId: owner.userId,
      })),
    );

    await expect(client().deployments.prepare({ ...source, serverId })).rejects.toMatchObject({
      status: 403,
      body: { code: "GITHUB_TOKEN_REQUIRED" },
    });
    expect(requests.every((request) => request.token === null)).toBe(true);
    requests = [];
    expect((await client().deployments.prepare(source)).projectType).toBe("monorepo");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.token === `Bearer ${pat}`)).toBe(true);
  });
  it("requires a selection before trying ambiguous server tokens, then scans with the selected server", async () => {
    await db.update(schema.servers).set({ isLocal: false }).where(eq(schema.servers.id, serverId));
    const otherId = await addOtherServerToken();
    await expect(client().deployments.prepare(source)).rejects.toMatchObject({
      status: 409,
      body: { code: "GITHUB_SERVER_SELECTION_REQUIRED" },
    });
    expect(requests.every((request) => request.token === null)).toBe(true);
    requests = [];
    expect((await client().deployments.prepare({ ...source, serverId })).projectType).toBe(
      "monorepo",
    );
    expect(requests.every((request) => request.token === `Bearer ${pat}`)).toBe(true);
    requests = [];
    // Explicit selection is a pin, even if another server has a working token.
    await expect(
      client().deployments.prepare({ ...source, serverId: otherId }),
    ).rejects.toMatchObject({ status: 400 });
    expect(requests.every((request) => request.token === "Bearer unrelated-repository-pat")).toBe(
      true,
    );
  });
  it("scans public repositories anonymously even when several server tokens are eligible", async () => {
    publicReadAllowed = true;
    await db.update(schema.servers).set({ isLocal: false }).where(eq(schema.servers.id, serverId));
    await addOtherServerToken();
    expect((await client().deployments.prepare(source)).projectType).toBe("monorepo");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.token === null)).toBe(true);
  });
  it.each([false, true])(
    "prepares an uncatalogued repository's openship.json services (Cloud=%s)",
    async (cloudMode) => {
      env.CLOUD_MODE = cloudMode;
      publicReadAllowed = true;
      const originalFiles = { ...files };
      // A README and manifest are sufficient: no catalog entry, package.json,
      // Dockerfile or Compose file participates in this source preparation.
      for (const name of Object.keys(files)) delete files[name];
      Object.assign(files, {
        "README.md": "Deploy this project with OpenShip.\n",
        "openship.json": JSON.stringify({
          services: [
            {
              name: "web",
              image: "nginx:stable-alpine",
              exposed: true,
              exposedPort: "80",
              dependsOn: ["cache"],
            },
            { name: "cache", image: "valkey/valkey:8-alpine", volumes: ["cache-data:/data"] },
          ],
        }),
      });
      try {
        const intent = parseDeploySource({
          repo: "https://github.com/acme/private-workspace",
          branch: "main",
        });
        if (intent.kind !== "repo") throw new Error("Expected a repository deployment link");
        const scan = await client().deployments.prepare({
          source: "github",
          owner: intent.owner,
          repo: intent.repo,
          branch: intent.branch,
        });
        expect(scan.projectType).toBe("services");
        expect(scan.services).toHaveLength(2);
        expect(scan.services?.[0]).toMatchObject({
          name: "web",
          image: "nginx:stable-alpine",
          exposed: true,
          exposedPort: "80",
          dependsOn: ["cache"],
        });
        expect(scan.services?.[1]).toMatchObject({
          name: "cache",
          image: "valkey/valkey:8-alpine",
          volumes: ["cache-data:/data"],
        });
        expect(scan.configDiagnostics?.errors ?? []).toEqual([]);
        expect(requests.some((request) => request.path.endsWith("/contents/openship.json"))).toBe(
          true,
        );
        // Self-hosting reuses its configured local server credential. Cloud has
        // no account connection here and reads the public repository anonymously.
        expect(new Set(requests.map((request) => request.token))).toEqual(
          new Set([cloudMode ? null : `Bearer ${pat}`]),
        );
      } finally {
        for (const name of Object.keys(files)) delete files[name];
        Object.assign(files, originalFiles);
      }
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
  it("never borrows a connected server the caller cannot write to when there is no local default (#1630)", async () => {
    await db.update(schema.servers).set({ isLocal: false }).where(eq(schema.servers.id, serverId));
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
    await expect(buildDependencies.prepare(ctx, source)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(requests.every((req) => req.token !== `Bearer ${pat}`)).toBe(true);
  });
  it("requires server write permission in addition to repository access", async () => {
    await addCustomApp();
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
    // Exercise the reported explicit-server case through real HTTP/PAT auth too.
    await db.insert(schema.resourceGrant).values({
      id: crypto.randomUUID(),
      organizationId: owner.orgId,
      userId: owner.userId,
      resourceType: "deployment",
      resourceId: "*",
      permissionsJson: '["read", "write"]',
    });
    expect((await client().deployments.prepare({ ...source, serverId })).projectType).toBe(
      "monorepo",
    );
    requests = [];
    // Metadata/deployment permission cannot reveal editable source env values.
    await expect(
      buildDependencies.prepare(ctx, { ...source, serverId, includeEnv: true }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(requests).toHaveLength(0);
  });
  it.each([
    { explicit: false, customApp: false },
    { explicit: true, customApp: false },
    { explicit: false, customApp: true },
    { explicit: true, customApp: true },
  ])(
    "does not let server write permission replace repository access: %j",
    async ({ explicit, customApp }) => {
      if (customApp) await addCustomApp();
      await db
        .update(schema.servers)
        .set({ isLocal: false })
        .where(eq(schema.servers.id, serverId));
      const member = await repos.member.find(owner.orgId, owner.userId);
      await db
        .update(schema.member)
        .set({ role: "restricted" })
        .where(eq(schema.member.id, member!.id));
      await db.insert(schema.resourceGrant).values([
        {
          id: crypto.randomUUID(),
          organizationId: owner.orgId,
          userId: owner.userId,
          resourceType: "deployment",
          resourceId: "*",
          permissionsJson: '["read", "write"]',
        },
        {
          id: crypto.randomUUID(),
          organizationId: owner.orgId,
          userId: owner.userId,
          resourceType: "server",
          resourceId: serverId,
          permissionsJson: '["write"]',
        },
      ]);
      await expect(
        client().deployments.prepare({ ...source, ...(explicit ? { serverId } : {}) }),
      ).rejects.toMatchObject({
        status: 403,
        body: { code: "GITHUB_TOKEN_REQUIRED" },
      });
      expect(requests.every((request) => request.token !== `Bearer ${pat}`)).toBe(true);
    },
  );
  it.each([false, true])(
    "leaves Cloud's account-only authentication unchanged (custom App=%s)",
    async (customApp) => {
      if (customApp) await addCustomApp();
      env.CLOUD_MODE = true;
      await expect(client().deployments.prepare({ ...source, serverId })).rejects.toMatchObject({
        status: 403,
      });
      expect(requests.every((req) => req.token !== `Bearer ${pat}`)).toBe(true);
    },
  );
  it.each([429, 503])("does not hide a provider %s as a successful scan", async (status) => {
    providerStatus = status;
    await expect(client().deployments.prepare({ ...source, serverId })).rejects.toThrow(
      /GitHub API error/,
    );
  });
});
