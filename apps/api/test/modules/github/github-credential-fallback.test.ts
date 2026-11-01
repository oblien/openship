import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ localToken: vi.fn(), tokenFor: vi.fn(), apiBase: vi.fn(), instanceIdentity: vi.fn() }));
vi.mock("@repo/db", () => ({ repos: {}, db: {}, schema: {}, eq: vi.fn(), and: vi.fn() }));
vi.mock("better-auth/api", () => ({ APIError: class extends Error {} }));
vi.mock("@repo/platform/engine/config/env", () => ({ env: {} }));
vi.mock("@repo/platform/engine/lib/auth", () => ({ auth: {} }));
vi.mock("@repo/platform/engine/lib/org-actor", () => ({ resolveOrgOwner: vi.fn() }));
vi.mock("@repo/platform/engine/modules/github/github.local-auth", () => ({ getLocalGhToken: h.localToken }));
vi.mock("@repo/platform/engine/modules/github/github.token", () => ({ tokenFor: h.tokenFor }));
vi.mock("@repo/platform/engine/modules/github/github-source.service", () => ({ resolveGitHubApiBaseUrl: h.apiBase }));
vi.mock("@repo/platform/engine/modules/github/github-instance-access", () => ({ mayUseInstanceGitIdentity: h.instanceIdentity }));

import { githubFetch } from "@repo/platform/engine/modules/github/github.auth";
import { ghFetchPublic } from "@repo/platform/engine/modules/github/github.http";

const ctx = { userId: "u", organizationId: "o" } as never;
const options = { ctx, owner: "acme", repo: "api", url: "https://api.github.com/repos/acme/api" };
const reply = (status: number, body: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers });
let wire: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.resetAllMocks();
  h.apiBase.mockResolvedValue(null);
  h.instanceIdentity.mockResolvedValue(true);
  h.localToken.mockResolvedValue("stale-token");
  h.tokenFor.mockImplementation(async (_ctx, _purpose, target) =>
    target.exclude?.includes("app-installation") ? null : { token: "app-token", source: "app-installation" },
  );
  wire = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", wire);
});
afterEach(() => vi.unstubAllGlobals());

describe("GitHub repository reads with rejected credentials (#944)", () => {
  it.each([401, 403])("retries through the authorized App without selecting the rejected token again (%i)", async (status) => {
    wire.mockResolvedValueOnce(reply(status, { message: "Bad credentials" }))
      .mockResolvedValueOnce(reply(200, { full_name: "acme/api", private: true }));
    expect(await githubFetch(options)).toMatchObject({ full_name: "acme/api" });
    expect(h.tokenFor).toHaveBeenCalledWith(ctx, "local", expect.objectContaining({
      owner: "acme", repo: "api", op: "read", exclude: ["gh-cli"],
    }));
    expect(wire.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization")))
      .toEqual(["Bearer stale-token", "Bearer app-token"]);
  });

  it.each(["", "/branches", "/git/trees/main", "/contents/package.json"])("retries a public repository read anonymously: %s", async (path) => {
    h.tokenFor.mockResolvedValue(null);
    wire.mockResolvedValueOnce(reply(401, { message: "Bad credentials" }))
      .mockResolvedValueOnce(reply(200, { public: true }));
    expect(await githubFetch({ ...options, url: options.url + path })).toEqual({ public: true });
    expect(new Headers(wire.mock.calls[1]![1]?.headers).has("authorization")).toBe(false);
    expect(wire.mock.calls[1]![0]).toBe(options.url + path);
  });

  it("still permits public reads when no token is configured", async () => {
    h.localToken.mockResolvedValue(null);
    h.tokenFor.mockResolvedValue(null);
    wire.mockResolvedValue(reply(200, { public: true }));
    expect(await githubFetch(options)).toEqual({ public: true });
    expect(wire).toHaveBeenCalledOnce();
  });

  it("fails a private repository read when both authenticated and anonymous access fail", async () => {
    h.tokenFor.mockResolvedValue(null);
    wire.mockResolvedValueOnce(reply(401, { message: "Bad credentials" }))
      .mockResolvedValueOnce(reply(404, { message: "Not Found" }));
    await expect(githubFetch(options)).rejects.toMatchObject({ status: 401 });
    expect(wire).toHaveBeenCalledTimes(2);
  });

  it("can recover public reads even when the App credential is rejected too", async () => {
    wire.mockResolvedValueOnce(reply(401, { message: "Bad credentials" }))
      .mockResolvedValueOnce(reply(401, { message: "Bad credentials" }))
      .mockResolvedValueOnce(reply(200, { public: true }));
    expect(await githubFetch(options)).toEqual({ public: true });
    expect(wire).toHaveBeenCalledTimes(3);
    expect(h.tokenFor.mock.calls[1]![2].exclude).toEqual(["gh-cli", "app-installation"]);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("never replays a rejected %s", async (method) => {
    wire.mockResolvedValue(reply(401, { message: "Bad credentials" }));
    await expect(githubFetch({ ...options, method })).rejects.toMatchObject({ status: 401 });
    expect(wire).toHaveBeenCalledOnce();
    expect(h.localToken).not.toHaveBeenCalled();
  });

  it.each([
    [403, "API rate limit exceeded", {}],
    [403, "Forbidden", { "x-ratelimit-remaining": "0" }],
    [403, "Forbidden", { "retry-after": "60" }],
    [403, "You have triggered an abuse detection mechanism", {}],
    [404, "Not Found", {}],
    [429, "Too many requests", {}],
    [503, "Unavailable", {}],
  ] as const)("does not retry a rate limit, missing resource, or outage: %i %s", async (status, message, headers) => {
    wire.mockResolvedValue(reply(status, { message }, headers));
    await expect(githubFetch(options)).rejects.toMatchObject({ status });
    expect(wire).toHaveBeenCalledOnce();
    expect(h.tokenFor).not.toHaveBeenCalled();
  });

  it("honors explicit App-only credentials before reading the host identity", async () => {
    wire.mockResolvedValue(reply(200, { ok: true }));
    await githubFetch({ ...options, credential: ["app-installation"] });
    expect(h.localToken).not.toHaveBeenCalled();
    expect(new Headers(wire.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer app-token");
  });

  it("does not use the instance's identity when the execution context forbids it", async () => {
    h.instanceIdentity.mockResolvedValue(false);
    h.tokenFor.mockResolvedValue(null);
    wire.mockResolvedValue(reply(200, { public: true }));
    await githubFetch(options);
    expect(h.localToken).not.toHaveBeenCalled();
    expect(new Headers(wire.mock.calls[0]![1]?.headers).has("authorization")).toBe(false);
  });

  it("never substitutes github.com for an Enterprise repository on auth failure", async () => {
    h.apiBase.mockResolvedValue("https://github.internal.test/api/v3");
    wire.mockResolvedValue(reply(401, { message: "Bad credentials" }));
    await expect(githubFetch(options)).rejects.toMatchObject({ status: 401 });
    expect(wire).toHaveBeenCalledOnce();
    expect(wire.mock.calls[0]![0]).toBe("https://github.internal.test/api/v3/repos/acme/api");
    expect(h.localToken).not.toHaveBeenCalled();
  });

  it("strips caller-provided credentials from an anonymous retry", async () => {
    wire.mockResolvedValue(reply(200, { public: true }));
    await ghFetchPublic({ url: options.url, headers: { authorization: "Bearer stale", Cookie: "session=private" } });
    const headers = new Headers(wire.mock.calls[0]![1]?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
  });
});
