import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const github = vi.hoisted(() => ({
  status: vi.fn(),
  oauth: vi.fn(),
  installs: vi.fn(),
  installToken: vi.fn(),
  fetch: vi.fn(),
  send: vi.fn(),
  hostToken: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", async (original) => {
  const config = await original<typeof import("@repo/platform/engine/config/env")>();
  return { ...config, env: { ...config.env, CLOUD_MODE: true, GITHUB_APP_ID: "9" } };
});
vi.mock("@repo/platform/engine/modules/github/github.auth", async (original) => ({
  ...(await original<object>()),
  getUserStatus: github.status,
  getUserToken: github.oauth,
  getUserInstallations: github.installs,
  getInstallationToken: github.installToken,
}));
vi.mock("@repo/platform/engine/modules/github/github.http", async (original) => ({
  ...(await original<object>()),
  ghFetch: github.fetch,
  ghSend: github.send,
}));
vi.mock("@repo/platform/engine/modules/github/github.local-auth", async (original) => ({
  ...(await original<object>()),
  getLocalGhToken: github.hostToken,
}));

import {
  db,
  schema,
  repos,
  seedOwner,
  installFakeRunner,
  type SeededOwner,
} from "../jobs/_harness";
import type { ExecutionContext } from "@repo/platform";
import type { GitHubRepository } from "@repo/contracts";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { tokenFor, canResolveTokenFor } from "@repo/platform/engine/modules/github/github.token";
import { resolveBuildGitToken } from "@repo/platform/engine/modules/github/clone-auth";
import { GitHubApiError } from "@repo/platform/engine/modules/github/github.http";
import * as sources from "@repo/platform/engine/modules/github/github-source.service";
import { githubRoutes } from "../../../src/modules/github/github.routes";
import { settingsRoutes } from "../../../src/modules/settings/settings.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { decrypt } from "@repo/platform/engine/lib/encryption";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { env } from "@repo/platform/engine/config/env";

installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/github", githubRoutes)
  .route("/api/settings", settingsRoutes);

async function clients(actor: SeededOwner, organizationId = actor.orgId) {
  const user = (await repos.user.findById(actor.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: { resolve: async () => ({ user, sessionId: "personal-token-test" }) },
  });
  return {
    native: await ship.scope({ identity: "verified", organizationId }),
    http: new OpenshipClient({
      baseUrl: "http://openship.test",
      token: actor.token,
      organizationId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    }),
  };
}

function raw(owner: string, name: string, id = 1): GitHubRepository {
  return {
    id,
    name,
    full_name: `${owner}/${name}`,
    owner: {
      login: owner,
      id: id + 1000,
      avatar_url: "",
      type: owner === "team" ? "Organization" : "User",
    },
    private: true,
    visibility: "private",
    default_branch: "main",
    description: null,
    language: null,
    html_url: `https://github.com/${owner}/${name}`,
    clone_url: `https://github.com/${owner}/${name}.git`,
    ssh_url: "",
    size: 1,
    forks: 0,
    watchers: 0,
    stargazers_count: 0,
    license: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    pushed_at: "2026-01-01T00:00:00Z",
  };
}

let personalRepos: GitHubRepository[];
let appRepos: GitHubRepository[];
let rejected: boolean;
beforeEach(() => {
  vi.clearAllMocks();
  env.CLOUD_MODE = true;
  rejected = false;
  personalRepos = [
    raw("alice", "private-app"),
    raw("team", "service", 2),
    raw("collaborator", "shared", 3),
  ];
  appRepos = [];
  github.status.mockResolvedValue({ connected: false, tokenSource: null });
  github.oauth.mockResolvedValue(null);
  github.installs.mockResolvedValue([]);
  github.installToken.mockResolvedValue(null);
  github.hostToken.mockResolvedValue("must-never-use-host-token");
  github.send.mockImplementation(async (token: string) =>
    Response.json(
      token === "bad-token"
        ? { message: "Bad credentials" }
        : { login: token === "bob-token" ? "bob" : "alice" },
      { status: token === "bad-token" ? 401 : 200, headers: { "x-oauth-scopes": "repo" } },
    ),
  );
  github.fetch.mockImplementation(
    async (token: string, request: { url: string; params?: Record<string, number> }) => {
      if (token === "app-token" && request.url.endsWith("/installation/repositories")) {
        return { total_count: appRepos.length, repositories: appRepos };
      }
      if (rejected) throw new GitHubApiError(401, "Bad credentials", new Headers());
      if (request.url.endsWith("/user"))
        return {
          login: token === "bob-token" ? "bob" : "alice",
          id: 7,
          avatar_url: "",
          type: "User",
        };
      if (request.url.endsWith("/user/repos")) {
        const start = ((request.params?.page ?? 1) - 1) * 100;
        return personalRepos.slice(start, start + 100);
      }
      if (request.url.endsWith("/branches"))
        return [{ name: "main", commit: { sha: "abc", url: "" }, protected: false }];
      if (request.url.endsWith("/repos/alice/private-app")) return raw("alice", "private-app");
      throw new Error(`Unexpected GitHub request: ${request.url}`);
    },
  );
});
afterEach(() => vi.restoreAllMocks());

describe("Personal GitHub tokens through Cloud HTTP, native SDK and shared engine", () => {
  it("activates the first saved token and uses it to browse, inspect and resolve remote clones without OAuth or an App", async () => {
    const actor = await seedOwner(),
      c = await clients(actor);
    // Existing preferences have the database's false default, which previously
    // made a newly saved token silently inactive.
    await c.http.settings.setBuildMode({ buildMode: "auto" });
    expect((await c.http.settings.get()).cloneToken.asDefault).toBe(false);
    expect(await c.http.settings.setCloneCredentials({ token: "  alice-token  " })).toMatchObject({
      cloneToken: { hasToken: true, asDefault: true },
    });
    expect(decrypt((await repos.settings.findByUser(actor.userId))!.cloneTokenEncrypted!)).toBe(
      "alice-token",
    );
    for (const client of [c.http, c.native]) {
      const home = await client.github.getHome();
      expect(home.state).toMatchObject({
        primary: "personal-token",
        sources: {
          personalToken: { connected: true, login: "alice" },
          openshipApp: { connected: false },
          ghCli: { available: false },
        },
      });
      expect(home.accounts.map((a) => a.login)).toEqual(["alice", "team", "collaborator"]);
      expect(home.accounts.every((a) => a.source === "token")).toBe(true);
      expect(home.repos).toHaveLength(3);
      expect(home.installUrl).toBe("");
      expect(await client.github.getStatus({ includeInstallUrl: false })).toMatchObject({
        state: home.state,
      });
      expect(
        (await client.github.listRepos({ owner: "CoLlAbOrAtOr" })).data.map((r) => r.full_name),
      ).toEqual(["collaborator/shared"]);
      expect(await client.github.getRepo({ owner: "alice", repo: "private-app" })).toMatchObject({
        default_branch: "main",
        private: true,
      });
      expect(
        (await client.github.listBranches({ owner: "alice", repo: "private-app" })).data,
      ).toMatchObject([{ name: "main" }]);
      expect(JSON.stringify(home)).not.toContain("alice-token");
    }
    const ctx = { userId: actor.userId, organizationId: actor.orgId } as ExecutionContext;
    expect(await canResolveTokenFor(ctx, "remote", { owner: "alice", repo: "private-app" })).toBe(
      "user-pat",
    );
    expect(await tokenFor(ctx, "remote", { owner: "alice", repo: "private-app" })).toEqual({
      token: "alice-token",
      source: "user-pat",
    });
    expect(
      await resolveBuildGitToken({
        ctx,
        projectId: "new-project",
        owner: "alice",
        repo: "private-app",
        buildStrategy: "server",
      }),
    ).toEqual({ token: "alice-token" });
    expect(github.hostToken).not.toHaveBeenCalled();
    expect(github.installToken).not.toHaveBeenCalledWith(
      expect.anything(),
      "alice",
      expect.anything(),
    );
    await flushAudit();
    expect(JSON.stringify(await c.native.audit.list())).not.toContain("alice-token");
  });

  it("paginates past 100 repositories and keeps organization/collaborator accounts selectable", async () => {
    const c = await clients(await seedOwner());
    personalRepos = Array.from({ length: 205 }, (_, i) =>
      raw(i === 204 ? "collaborator" : "team", `repo-${i}`, i + 1),
    );
    await c.http.settings.setCloneCredentials({ token: "alice-token" });
    const home = await c.http.github.getHome();
    expect(home.repos).toHaveLength(205);
    expect(home.accounts.map((a) => a.login)).toEqual(["alice", "team", "collaborator"]);
    const page = await c.http.github.listRepos({ owner: "team", page: 11, perPage: 20 });
    expect(page).toMatchObject({ total: 204, count: 204, totalPages: 11 });
    expect(page.data).toHaveLength(4);
  });

  it("uses the same personal-token source on self-hosted instances without reading a host identity", async () => {
    env.CLOUD_MODE = false;
    const c = await clients(await seedOwner());
    await c.http.settings.setCloneCredentials({ token: "alice-token" });
    expect((await c.http.github.getHome()).state.primary).toBe("personal-token");
    github.fetch.mockClear();
    expect((await c.http.github.listRepos({ owner: "team" })).data.map((r) => r.name)).toEqual([
      "service",
    ]);
    expect(
      github.fetch.mock.calls.filter(([, request]) => request.url.endsWith("/user/repos")),
    ).toHaveLength(1);
    expect(github.hostToken).not.toHaveBeenCalled();
  });

  it("replaces and clears the token without borrowing another user's saved credential", async () => {
    const actor = await seedOwner(),
      c = await clients(actor),
      other = await clients(await seedOwner());
    await c.http.settings.setCloneCredentials({ token: "alice-token" });
    expect((await other.http.github.getHome()).state.primary).toBeNull();
    personalRepos = [raw("bob", "different-repo")];
    await c.native.settings.setCloneCredentials({ token: "bob-token" });
    expect((await c.http.github.getHome()).state.sources.personalToken?.login).toBe("bob");
    await c.http.settings.setCloneCredentials({ token: null });
    expect((await c.native.github.getHome()).state.primary).toBeNull();
    expect((await c.http.settings.get()).cloneToken).toMatchObject({
      hasToken: false,
      asDefault: false,
    });
  });

  it("honors an explicit opt-out, keeps it on replacement, and activates only when enabled", async () => {
    const c = await clients(await seedOwner());
    await c.http.settings.setCloneCredentials({ token: "alice-token", asDefault: false });
    expect((await c.http.github.getHome()).state.primary).toBeNull();
    await c.http.settings.setCloneCredentials({ token: "bob-token" });
    expect((await c.http.settings.get()).cloneToken.asDefault).toBe(false);
    await c.native.settings.setCloneCredentials({ asDefault: true });
    expect((await c.http.github.getHome()).state.sources.personalToken?.login).toBe("bob");
  });

  it("rejects invalid or whitespace tokens without overwriting the working credential", async () => {
    const actor = await seedOwner(),
      c = await clients(actor);
    await c.http.settings.setCloneCredentials({ token: "alice-token" });
    const before = await repos.settings.findByUser(actor.userId);
    for (const client of [c.http, c.native]) {
      await expect(
        client.settings.setCloneCredentials({ token: "bad-token" }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(client.settings.setCloneCredentials({ token: "   " })).rejects.toMatchObject({
        statusCode: 400,
      });
    }
    expect(await repos.settings.findByUser(actor.userId)).toEqual(before);
    expect((await c.http.github.getHome()).state.primary).toBe("personal-token");
  });

  it("validates classic scopes, accepts fine-grained tokens and keeps the old token during a GitHub outage", async () => {
    const actor = await seedOwner(),
      c = await clients(actor);
    await c.http.settings.setCloneCredentials({ token: "alice-token" });
    const before = await repos.settings.findByUser(actor.userId);
    github.send.mockResolvedValueOnce(
      Response.json({ login: "alice" }, { headers: { "x-oauth-scopes": "read:user" } }),
    );
    await expect(
      c.http.settings.setCloneCredentials({ token: "under-scoped" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    github.send.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(
      c.native.settings.setCloneCredentials({ token: "replacement" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await repos.settings.findByUser(actor.userId)).toEqual(before);
    github.send.mockResolvedValueOnce(Response.json({ login: "alice" }));
    await c.http.settings.setCloneCredentials({ token: "github_pat_fine_grained" });
    expect((await c.http.github.getHome()).repos).toHaveLength(3);
  });

  it("merges App coverage without duplicates and keeps App access working after a token is revoked", async () => {
    const c = await clients(await seedOwner());
    await c.http.settings.setCloneCredentials({ token: "alice-token" });
    github.status.mockResolvedValue({
      connected: true,
      tokenSource: "oauth",
      login: "alice",
      id: 7,
      avatar_url: "",
    });
    github.installs.mockResolvedValue([
      { id: 42, account: { login: "team", id: 12, avatar_url: "", type: "Organization" } },
    ]);
    github.installToken.mockResolvedValue("app-token");
    appRepos = [raw("team", "service", 2), raw("team", "app-only", 4)];
    const home = await c.http.github.getHome();
    expect(home.repos).toHaveLength(4);
    expect(home.repos.find((r) => r.full_name === "team/service")?.source).toBe("app");
    expect(home.accounts.filter((a) => a.login === "team")).toMatchObject([{ source: "app" }]);
    rejected = true;
    const fallback = await c.http.github.getHome();
    expect(fallback.state.primary).toBe("openship-app");
    expect(fallback.state.sources.personalToken).toMatchObject({
      connected: false,
      problem: "rejected",
    });
    expect(fallback.errors?.token).toContain("Settings");
    expect((await c.http.github.listRepos({ owner: "team" })).data).toHaveLength(2);
  });

  it("keeps repo grants and tenant filtering in force for a member's personal token", async () => {
    const owner = await seedOwner(),
      member = await seedOwner({ bound: false });
    await (await clients(member)).http.settings.setCloneCredentials({ token: "alice-token" });
    await db.insert(schema.member).values({
      id: `git_${member.userId}`,
      organizationId: owner.orgId,
      userId: member.userId,
      role: "restricted",
    });
    await repos.resourceGrant.upsert({
      organizationId: owner.orgId,
      userId: member.userId,
      resourceType: "github_repository",
      resourceId: "team/service",
      permissions: ["read"],
      grantedByUserId: owner.userId,
    });
    const c = await clients(member, owner.orgId);
    personalRepos.push(raw("team", "hidden", 4));
    for (const client of [c.http, c.native]) {
      const list = await client.github.listOrgRepos({ org: "team" });
      expect(list.data.map((r) => r.full_name)).toEqual(["team/service"]);
      expect(list.total).toBe(1);
      await expect(client.github.getHome()).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        client.github.getRepo({ owner: "alice", repo: "private-app" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("does not mix same-named GitHub.com repositories into a configured Enterprise owner", async () => {
    vi.spyOn(sources, "resolveGitHubApiBaseUrl").mockImplementation(async (_org, owner) =>
      owner.toLowerCase() === "team" ? "https://github.enterprise.test/api/v3" : null,
    );
    const c = await clients(await seedOwner());
    await c.http.settings.setCloneCredentials({ token: "alice-token" });
    const home = await c.http.github.getHome();
    expect(home.repos.map((r) => r.owner)).toEqual(["alice", "collaborator"]);
    expect(home.accounts.map((a) => a.login)).not.toContain("team");
    expect((await c.http.github.listRepos({ owner: "team" })).data).toEqual([]);
    expect(
      github.fetch.mock.calls.every(([, req]) => req.url.startsWith("https://api.github.com/")),
    ).toBe(true);
  });
});
