import { env } from "@repo/platform/engine/config/env";
import { createHmac, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { assembleGitClone } from "@repo/adapters";
import { db, repos, schema } from "@repo/db";
import { seedOrg, seedProject } from "../../helpers/seed";
import { getGitProvider } from "@repo/platform/engine/modules/git/provider";
import { ensureSharedWebhook } from "@repo/platform/engine/modules/projects/project-git-webhook";
import { createProjectGitOperations } from "@repo/platform/engine/modules/projects/project-git.operations";
import { createCredential } from "@repo/platform/engine/modules/credentials/credential.service";
import { registerWebhookProvider } from "@repo/platform/engine/modules/webhooks/webhook.service";
import { gitlabWebhookProvider } from "../../../src/modules/gitlab/gitlab.webhook";
import { webhookRoutes } from "../../../src/modules/webhooks/webhook.routes";
import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";
import { handleApiError } from "../../../src/middleware/error-handler";

const deploy = vi.hoisted(() => vi.fn());
vi.mock("@repo/platform/engine/modules/deployments/build.service", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/deployments/build.service")>()),
  triggerDeployment: deploy,
}));
const ref = { provider: "gitlab", namespace: "acme/platform", name: "widgets" };
const repo = {
  id: 34,
  path: ref.name,
  path_with_namespace: "acme/platform/widgets",
  namespace: { full_path: ref.namespace },
  default_branch: "main",
  visibility: "private",
  web_url: "https://gitlab.com/acme/platform/widgets",
};
const adapter = getGitProvider("gitlab");
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("verifies and encrypts a GitLab connection and uses it only for its workspace and clone origin", async () => {
  const { organizationId, userId } = await seedOrg();
  const ctx = buildBackgroundContext({ organizationId, userId, label: "test" });
  const token = randomUUID();
  const transport = vi.fn(async (input: URL, init: RequestInit) => {
    expect(input.origin).toBe("https://gitlab.com");
    expect(init.redirect).toBe("error");
    const authenticated = new Headers(init.headers).get("Authorization") === `Bearer ${token}`;
    if (!authenticated) return Response.json({}, { status: 404 });
    if (input.pathname === "/api/v4/projects") return Response.json([repo]);
    if (input.pathname === "/api/v4/projects/acme%2Fplatform%2Fwidgets") return Response.json(repo);
    throw new Error("Unexpected GitLab request");
  });
  vi.stubGlobal("fetch", transport);
  const saved = await createCredential(organizationId, {
    provider: "gitlab",
    name: "workspace",
    values: { apiToken: token },
  });
  expect(JSON.stringify(saved)).not.toContain(token);
  expect(await adapter.listRepositories(ctx)).toMatchObject([
    { full_name: repo.path_with_namespace },
  ]);
  const clone = {
    ctx,
    projectId: "test",
    owner: ref.namespace,
    repo: ref.name,
    buildStrategy: "local" as const,
    repoUrl: repo.web_url + ".git",
  };
  const grant = await adapter.resolveCloneCredentials(clone);
  expect(grant).toMatchObject({ token, tokenRepositories: [ref.name] });
  const invocation = assembleGitClone({
    repoUrl: clone.repoUrl,
    gitToken: grant.token,
    gitTokenRepositories: grant.tokenRepositories,
  });
  expect(invocation.cloneUrl).toBe(clone.repoUrl);
  expect(invocation.gitEnv).toContain("acme/platform/widgets");
  expect(invocation.cloneUrl).not.toContain(token);
  await expect(
    adapter.resolveCloneCredentials({
      ...clone,
      repoUrl: "https://github.com/acme/platform/widgets.git",
    }),
  ).rejects.toThrow("origin");
  const other = await seedOrg();
  const otherCtx = buildBackgroundContext({ ...other, label: "test" });
  expect(await adapter.listRepositories(otherCtx)).toBeNull();
  await expect(adapter.repository(otherCtx, ref).info()).rejects.toMatchObject({ statusCode: 404 });
});

it("offers reconnection for a revoked token and preserves retryable provider errors", async () => {
  const ctx = buildBackgroundContext({ ...(await seedOrg()), label: "test" });
  const transport = vi.fn().mockResolvedValue(Response.json([]));
  vi.stubGlobal("fetch", transport);
  await createCredential(ctx.organizationId, {
    provider: "gitlab", name: "team", values: { apiToken: randomUUID() },
  });
  const { gitDependencies } = await import("@repo/platform/engine/modules/git/git.operations");
  for (const status of [401, 403, 429, 503]) {
    transport.mockResolvedValueOnce(Response.json({}, { status }));
    await expect(gitDependencies.listRepos(ctx, { provider: "gitlab" })).rejects.toMatchObject(
      status === 401 || status === 403 ? { code: "GIT_CONNECTION_REQUIRED" } : { statusCode: status },
    );
  }
});

it("creates a Cloud GitLab project without claiming auto-deploy is already enabled", async () => {
  const { organizationId, userId } = await seedOrg();
  const ctx = buildBackgroundContext({ organizationId, userId, label: "test" });
  const billing = await import("@repo/platform/engine/modules/billing/management.service");
  const { createProject } = await import("@repo/platform/engine/modules/projects/project-crud.service");
  // This test covers the creation funnel independently of host billing.
  vi.spyOn(billing, "isCustomerServer").mockResolvedValue(true);
  const previousMode = env.CLOUD_MODE;
  env.CLOUD_MODE = true;
  try {
    const created = await createProject({
      name: "Cloud GitLab project",
      gitProvider: ref.provider,
      gitOwner: ref.namespace,
      gitRepo: ref.name,
      gitBranch: "main",
      installationId: 42,
    }, organizationId, undefined, ctx);
    expect(await repos.project.findById(created.id)).toMatchObject({
      gitProvider: "gitlab",
      autoDeploy: false,
      webhookId: null,
      installationId: null,
    });
  } finally {
    env.CLOUD_MODE = previousMode;
  }
});

it("dispatches a signed subgroup push once to the intended provider and workspace", async () => {
  const { organizationId, userId } = await seedOrg();
  const other = await seedOrg();
  const fields = {
    gitProvider: ref.provider,
    gitOwner: ref.namespace,
    gitRepo: ref.name,
    gitBranch: "main",
    autoDeploy: true,
  };
  const project = await seedProject(organizationId, { ...fields, autoDeploy: false });
  const otherProject = await seedProject(other.organizationId, fields);
  await seedProject(organizationId, { ...fields, gitProvider: "github" });
  const hooks: Array<{ id: number; name: string; url: string; push_events: boolean }> = [];
  const tokens: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL, init: RequestInit) => {
      if (input.pathname === "/api/v4/projects") return Response.json([repo]);
      if (input.pathname === "/api/v4/projects/acme%2Fplatform%2Fwidgets")
        return Response.json(repo);
      if (input.pathname.endsWith("/repository/compare")) return Response.json({}, { status: 404 });
      if (!input.pathname.startsWith("/api/v4/projects/acme%2Fplatform%2Fwidgets/hooks"))
        throw new Error("Unexpected GitLab request");
      if (!init.method) return Response.json(hooks);
      const { name, signing_token, url, enable_ssl_verification, push_events } = JSON.parse(String(init.body));
      if (init.method === "PUT" && !signing_token) {
        const hook = hooks.find((h) => input.pathname.endsWith("/hooks/" + h.id))!;
        hook.push_events = push_events;
        return Response.json(hook);
      }
      expect(enable_ssl_verification).toBe(true);
      expect(signing_token).toMatch(/^whsec_/);
      tokens.push(signing_token);
      if (init.method === "POST") hooks.push({ id: 15 + hooks.length, name, url, push_events });
      return Response.json(hooks.find((hook) => hook.name === name));
    }),
  );
  await createCredential(organizationId, {
    provider: "gitlab",
    name: "push",
    values: { apiToken: randomUUID() },
  });
  const ctx = buildBackgroundContext({ organizationId, userId, label: "test" });
  const webhook = adapter.repository(ctx, ref).webhooks!;
  const previousUrl = env.OPENSHIP_PUBLIC_URL;
  env.OPENSHIP_PUBLIC_URL = "https://openship.example";
  try {
    expect(hooks).toHaveLength(0);
    await createProjectGitOperations(vi.fn()).setAutoDeploy(ctx, project.id, { enabled: true });
    expect(await repos.project.findById(project.id)).toMatchObject({
      autoDeploy: true,
      webhookId: "15",
    });
  } finally {
    env.OPENSHIP_PUBLIC_URL = previousUrl;
  }
  const opts = { projectId: project.id, url: hooks[0]!.url };
  expect(await ensureSharedWebhook(ctx, project, ref, opts.url)).toBe("15");
  expect(hooks).toHaveLength(1);
  expect(tokens).toHaveLength(2);
  expect(tokens[1]).toEqual(tokens[0]);
  await createCredential(other.organizationId, {
    provider: "gitlab",
    name: "another workspace",
    values: { apiToken: randomUUID() },
  });
  const otherCtx = buildBackgroundContext({ ...other, label: "test" });
  await expect(webhook.register({ ...opts, projectId: otherProject.id })).rejects.toMatchObject({
    statusCode: 404,
  });
  expect(await ensureSharedWebhook(otherCtx, otherProject, ref, opts.url)).toBe("16");
  expect(tokens[2]).not.toBe(tokens[0]);
  const key = Buffer.from(tokens[0].slice(6), "base64");
  expect(key).toHaveLength(32);
  expect((await repos.project.findById(project.id))?.webhookSecret).not.toContain(
    tokens[0].slice(6),
  );
  const body = JSON.stringify({
    object_kind: "push",
    ref: "refs/heads/main",
    before: "b".repeat(40),
    after: "a".repeat(40),
    project: { path_with_namespace: repo.path_with_namespace, default_branch: "main" },
  });
  const id = randomUUID(),
    stamp = String(Math.floor(Date.now() / 1000));
  const signature =
    "v1," +
    createHmac("sha256", key)
      .update(id + "." + stamp + "." + body)
      .digest("base64");
  registerWebhookProvider(gitlabWebhookProvider);
  const app = new Hono()
    .onError(handleApiError)
    .use("*", async (c, next) => {
      c.set("clientIp", "192.0.2.25");
      return next();
    })
    .route("/api/webhooks", webhookRoutes);
  const send = (raw: string, timestamp = stamp) =>
    app.request("/api/webhooks/gitlab", {
      method: "POST",
      body: raw,
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": signature,
      },
    });
  deploy.mockReset().mockResolvedValue({ skipped: true });
  expect((await send(body + " ")).status).toBe(401);
  expect((await send(body, "100")).status).toBe(401);
  expect((await send(body)).status).toBe(200);
  expect((await send(body)).status).toBe(200);
  expect(deploy).toHaveBeenCalledTimes(1);
  expect(deploy.mock.calls[0][1]).toMatchObject({
    projectId: project.id,
    branch: "main",
    commitSha: "a".repeat(40),
  });
  await createProjectGitOperations(vi.fn()).setAutoDeploy(ctx, project.id, { enabled: false });
  expect(hooks.map((h) => h.push_events)).toEqual([false, true]);
});

it("keeps scoped GitLab file grants independent of GitHub and sibling subgroups", async () => {
  const owner = await seedOrg(),
    member = await seedOrg();
  await db.insert(schema.member).values({
    id: randomUUID(),
    organizationId: owner.organizationId,
    userId: member.userId,
    role: "restricted",
  });
  const ctx = buildBackgroundContext({
    organizationId: owner.organizationId,
    userId: member.userId,
    label: "scoped",
  });
  const grant = {
    organizationId: owner.organizationId,
    userId: member.userId,
    resourceId: repo.path_with_namespace,
    permissions: ["read"],
    scope: { v: 1 as const, read: { paths: ["src/**"] } },
    grantedByUserId: owner.userId,
  };
  await repos.resourceGrant.upsert({ ...grant, resourceType: "github_repository" });
  const target = { owner: ref.namespace, repo: ref.name };
  expect(await adapter.access.canUse(ctx, target, "read")).toBe(false);
  await repos.resourceGrant.upsert({ ...grant, resourceType: "gitlab_repository" });
  expect(await adapter.access.canUse(ctx, target, "read")).toBe(true);
  expect((await adapter.access.checkSource(ctx, target, "content", "src/index.ts")).ok).toBe(true);
  expect((await adapter.access.checkSource(ctx, target, "content", "private.txt")).ok).toBe(false);
  expect(await adapter.access.canUse(ctx, { owner: "acme", repo: ref.name }, "read")).toBe(false);
  expect(await adapter.access.canUse(ctx, { owner: "acme" }, "read")).toBe(false);
  expect(
    await adapter.access.canUse(ctx, { owner: ref.namespace }, "read", { ownerLevel: "authority" }),
  ).toBe(false);
});

it("links GitLab OAuth, rotates once across concurrent private repository reads and isolates the grant", async () => {
  const { createHash } = await import("node:crypto");
  const { beginConnectionAuthorization, completeConnectionAuthorization, getProviderAccess } =
    await import("@repo/platform/engine/modules/credentials/connection-authorization");
  const { readCredentialSecrets, writeCredentialSecrets } =
    await import("@repo/platform/engine/modules/credentials/credential.service");
  const http = await import("@repo/platform/engine/modules/credentials/provider-api");
  const ctx = buildBackgroundContext({ ...(await seedOrg()), label: "gitlab-oauth" });
  vi.stubEnv("OPENSHIP_CONNECTION_GITLAB_CLIENT_ID", "test-client");
  vi.stubEnv("OPENSHIP_CONNECTION_GITLAB_CLIENT_SECRET", "test-client-secret");
  const grant = (access: string) => ({
    access_token: access,
    expires_in: 7200,
    refresh_token: access + "-refresh",
  });
  const exchange = vi
    .spyOn(http, "providerJson")
    .mockResolvedValueOnce(grant("first"))
    .mockResolvedValueOnce(grant("second"));
  const transport = vi.fn(async (url: URL, init: RequestInit) => {
    const auth = new Headers(init.headers).get("Authorization");
    expect(["Bearer first", "Bearer second"]).toContain(auth);
    expect(url.origin).toBe("https://gitlab.com");
    if (url.pathname === "/api/v4/projects") return Response.json([repo]);
    expect(url.pathname).toBe("/api/v4/projects/acme%2Fplatform%2Fwidgets");
    return Response.json(repo);
  });
  vi.stubGlobal("fetch", transport);
  const started = await beginConnectionAuthorization(ctx, {
    provider: "gitlab",
    name: "My GitLab",
  });
  const url = new URL(started.url);
  expect(url.origin + url.pathname).toBe("https://gitlab.com/oauth/authorize");
  expect(url.searchParams.get("scope")).toBe("api read_repository");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  await expect(
    completeConnectionAuthorization(
      { ...ctx, sessionId: "another" },
      { state: started.state, code: "code" },
    ),
  ).rejects.toMatchObject({ code: "CONNECTION_STATE_MISMATCH" });
  const saved = await completeConnectionAuthorization(ctx, { state: started.state, code: "code" });
  expect(saved.publicFields.authorization).toBe("oauth");
  expect(JSON.stringify(saved)).not.toContain("first");
  const [endpoint, request] = exchange.mock.calls[0];
  expect(endpoint.href).toBe("https://gitlab.com/oauth/token");
  const form = new URLSearchParams(request?.body);
  expect(form.get("client_secret")).toBe("test-client-secret");
  expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(
    url.searchParams.get("code_challenge"),
  );
  const row = (await repos.credential.findById(ctx.organizationId, saved.id))!;
  expect(row.secretsEnc).not.toContain("first");
  const secrets = readCredentialSecrets(row);
  await repos.credential.update(ctx.organizationId, saved.id, {
    secretsEnc: writeCredentialSecrets({ ...secrets, _expiresAt: "1" }),
  });
  await expect(getProviderAccess(ctx.organizationId, saved.id)).rejects.toMatchObject({
    statusCode: 404,
  });
  const other = buildBackgroundContext({ ...(await seedOrg()), label: "other-workspace" });
  expect(await adapter.listRepositories(other)).toBeNull();
  await Promise.all([adapter.listRepositories(ctx), adapter.listRepositories(ctx)]);
  expect(exchange).toHaveBeenCalledTimes(2);
  const refresh = new URLSearchParams(exchange.mock.calls[1][1]?.body);
  expect(refresh.get("redirect_uri")).toBe(url.searchParams.get("redirect_uri"));
  expect(refresh.get("refresh_token")).toBe("first-refresh");
  expect(
    transport.mock.calls.slice(1).map(([, init]) => new Headers(init.headers).get("authorization")),
  ).toEqual(["Bearer second", "Bearer second"]);
  const clone = await adapter.resolveCloneCredentials({
    ctx,
    projectId: "test",
    owner: ref.namespace,
    repo: ref.name,
    repoUrl: repo.web_url + ".git",
    buildStrategy: "local",
  });
  expect(clone).toMatchObject({
    token: "second",
    tokenRepositories: [ref.name],
    apiHostFallback: true,
  });
  const remote = {
    ctx, projectId: "test", owner: ref.namespace, repo: ref.name, buildStrategy: "server" as const,
  };
  await expect(adapter.resolveCloneCredentials(remote)).rejects.toMatchObject({
    code: "GITLAB_CONNECTION_REQUIRED",
  });
  expect(await adapter.resolveCloneCredentials({ ...remote, allowApiHostFallback: true })).toMatchObject({
    token: "second",
    apiHostFallback: true,
  });
  await expect(
    completeConnectionAuthorization(ctx, { state: started.state, code: "again" }),
  ).rejects.toMatchObject({ code: "CONNECTION_STATE_EXPIRED" });
});

it("uses the host CLI only after operator consent, binds its account and never consults it on Cloud", async () => {
  const adapters = await import("@repo/adapters");
  const { canLinkGlab, connectGlab } = await import("@repo/platform/engine/modules/gitlab/cli");
  const probe = vi.spyOn(adapters, "readLocalGlabToken").mockResolvedValue("cli-secret");
  const owner = await seedOrg({ ownsHost: true });
  const ctx = { ...buildBackgroundContext({ ...owner }), sessionKind: "cookie" as const };
  const member = {
    ...buildBackgroundContext({ ...(await seedOrg()) }),
    sessionKind: "cookie" as const,
  };
  const account = { id: 11, username: "operator" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      const header = new Headers(init.headers).get("Authorization");
      if (!header) return Response.json({}, { status: 404 });
      expect(header).toBe("Bearer cli-secret");
      if (url.pathname === "/api/v4/user") return Response.json(account);
      return Response.json(url.pathname === "/api/v4/projects" ? [repo] : repo);
    }),
  );
  await expect(connectGlab(member, "not allowed")).rejects.toMatchObject({ statusCode: 403 });
  await expect(connectGlab({ ...ctx, sessionKind: "bearer" }, "automation")).rejects.toMatchObject({
    statusCode: 403,
  });
  expect(await adapter.listRepositories(ctx)).toBeNull();
  expect(probe).not.toHaveBeenCalled();
  const saved = await connectGlab(ctx, "Local glab");
  expect(saved.publicFields).toMatchObject({ username: "operator", authorization: "host-cli" });
  const row = (await repos.credential.findById(ctx.organizationId, saved.id))!;
  const { readCredentialSecrets } =
    await import("@repo/platform/engine/modules/credentials/credential.service");
  expect(readCredentialSecrets(row)).toEqual({ glabUserId: "11" });
  expect(await adapter.listRepositories(ctx)).toMatchObject([{ name: ref.name }]);
  expect(await adapter.listRepositories(member)).toBeNull();
  const clone = {
    ctx,
    owner: ref.namespace,
    repo: ref.name,
    projectId: "project",
    buildStrategy: "server" as const,
  };
  const preflight = {
    ctx,
    namespace: ref.namespace,
    name: ref.name,
    remoteCredential: true,
    clonesOnRemote: true,
    dockerClonesOnTarget: false,
    effectiveTarget: "server",
    platformTarget: "self-hosted",
  };
  probe.mockClear();
  await expect(adapter.resolveCloneCredentials(clone)).rejects.toMatchObject({
    code: "GITLAB_CONNECTION_REQUIRED",
  });
  expect(await adapter.preflight!.checks(preflight)).toMatchObject([
    { status: "fail", code: "GITLAB_CONNECTION_REQUIRED" },
  ]);
  expect(probe).not.toHaveBeenCalled();
  expect(
    await adapter.resolveCloneCredentials({ ...clone, allowApiHostFallback: true }),
  ).toMatchObject({
    token: "cli-secret",
    apiHostFallback: true,
  });
  expect(
    await adapter.preflight!.checks({ ...preflight, dockerClonesOnTarget: true }),
  ).toMatchObject([{ status: "pass" }]);
  account.id = 12;
  await expect(adapter.listRepositories(ctx)).rejects.toThrow("account changed");
  const previous = env.CLOUD_MODE;
  env.CLOUD_MODE = true;
  probe.mockClear();
  try {
    expect(await canLinkGlab(ctx)).toBe(false);
    await expect(connectGlab(ctx, "cloud")).rejects.toMatchObject({ statusCode: 403 });
    await expect(adapter.listRepositories(ctx)).rejects.toMatchObject({ statusCode: 403 });
    expect(probe).not.toHaveBeenCalled();
  } finally {
    env.CLOUD_MODE = previous;
  }
});
