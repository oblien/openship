import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = await vi.hoisted(async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  return {
    key: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
    tokenFor: vi.fn(),
    gate: vi.fn(),
    base: vi.fn(),
    cache: new Map<string, string>(),
  };
});
vi.mock("@repo/db", () => ({
  repos: {
    gitInstallation: {
      findByOrgAndOwner: async () => ({ sourceId: "source", installationId: 17 }),
    },
  },
  db: {},
  schema: {},
  eq: vi.fn(),
  and: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: {} }));
vi.mock("@repo/platform/engine/lib/auth", () => ({ auth: {} }));
vi.mock("@repo/platform/engine/lib/cache-store/index", () => ({
  cacheStore: async () => ({
    get: async (key: string) => h.cache.get(key) ?? null,
    set: async (key: string, value: string) => {
      h.cache.set(key, value);
    },
  }),
}));
vi.mock("@repo/platform/engine/modules/github/github-access", () => ({
  assertGitHubRepoAccess: h.gate,
}));
vi.mock("@repo/platform/engine/modules/github/github.token", () => ({ tokenFor: h.tokenFor }));
vi.mock("@repo/platform/engine/modules/github/github-source.service", () => ({
  resolveGitHubApiBaseUrl: h.base,
  resolveGitHubSourceCredentialsForInstallation: async () => ({
    source: { id: "source" },
    credentials: { appId: 123, privateKeyPem: h.key },
  }),
}));
import {
  githubFetch,
  getInstallationToken,
} from "@repo/platform/engine/modules/github/github.auth";
const opts = {
  ctx: { userId: "user", organizationId: "org" } as never,
  owner: "owner",
  repo: "repo",
  url: "https://api.github.com/repos/owner/repo",
  authorizeAs: "write" as const,
  installationPermissions: { contents: "write" as const, pull_requests: "write" as const },
};
let wire: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  vi.resetAllMocks();
  h.cache.clear();
  h.base.mockResolvedValue(null);
  h.tokenFor.mockResolvedValue({ source: "app-installation", token: "ordinary-app-token" });
  wire = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", wire);
});
afterEach(() => vi.unstubAllGlobals());

it("verifies both required App permissions for exactly this repository without changing credentials", async () => {
  wire
    .mockResolvedValueOnce(
      Response.json({
        token: "scoped-app-token",
        expires_at: "2099-01-01T00:00:00Z",
        repositories: [{ name: "repo" }],
        permissions: { ...opts.installationPermissions, metadata: "read" },
      }),
    )
    .mockResolvedValueOnce(Response.json({ permissions: { push: true } }));
  await githubFetch(opts);
  expect(h.tokenFor).toHaveBeenCalledWith(
    opts.ctx,
    "local",
    expect.objectContaining({ owner: "owner", repo: "repo", op: "write" }),
  );
  expect(h.gate).toHaveBeenCalledWith(opts.ctx, { owner: "owner", repo: "repo" }, "write");
  expect(JSON.parse(wire.mock.calls[0]![1]!.body as string)).toEqual({
    repositories: ["repo"],
    permissions: opts.installationPermissions,
  });
  expect(new Headers(wire.mock.calls[1]![1]!.headers).get("authorization")).toBe(
    "Bearer scoped-app-token",
  );
  wire.mockResolvedValueOnce(Response.json({ permissions: { push: true } }));
  await githubFetch(opts);
  // Publication reuses this verified scope rather than the older broad token.
  expect(wire).toHaveBeenCalledTimes(3);
  expect(new Headers(wire.mock.calls[2]![1]!.headers).get("authorization")).toBe(
    "Bearer scoped-app-token",
  );
});

it("keeps job-scoped token mints uncached by default", async () => {
  wire.mockImplementation(async () =>
    Response.json({
      token: "job-token",
      expires_at: "2099-01-01T00:00:00Z",
      repositories: [{ name: "repo" }],
      permissions: { contents: "read" },
    }),
  );
  for (let i = 0; i < 2; i++)
    await getInstallationToken(opts.ctx, "owner", undefined, {
      repositories: ["repo"],
      permissions: { contents: "read" },
    });
  expect(wire).toHaveBeenCalledTimes(2);
  expect(h.cache.size).toBe(0);
});
it.each([403, 422])(
  "surfaces a denied App scope without falling back to another identity (%i)",
  async (status) => {
    wire.mockResolvedValueOnce(
      Response.json(
        { message: "Permissions requested are not granted to this installation" },
        { status },
      ),
    );
    await expect(githubFetch(opts)).rejects.toMatchObject({ status });
    expect(wire).toHaveBeenCalledOnce();
    expect(h.tokenFor).toHaveBeenCalledOnce();
  },
);
it("rejects a provider that confirms different permissions or repositories", async () => {
  wire.mockResolvedValueOnce(
    Response.json({
      token: "wrong-token",
      repositories: [{ name: "other" }],
      permissions: { contents: "read" },
    }),
  );
  await expect(githubFetch(opts)).rejects.toMatchObject({ code: "ACTIONS_TOKEN_SCOPE_INVALID" });
  expect(wire).toHaveBeenCalledOnce();
});
it("keeps the connected user identity for PAT publication and requires write authority for any probe", async () => {
  h.tokenFor.mockResolvedValue({ source: "user-pat", token: "user-token" });
  wire.mockResolvedValue(Response.json({ permissions: { push: true } }));
  await githubFetch(opts);
  expect(new Headers(wire.mock.calls[0]![1]!.headers).get("authorization")).toBe(
    "Bearer user-token",
  );
  expect(wire).toHaveBeenCalledOnce();
  await expect(githubFetch({ ...opts, authorizeAs: "read" })).rejects.toMatchObject({
    statusCode: 400,
  });
  expect(wire).toHaveBeenCalledOnce();
});
