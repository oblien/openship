import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredCloudSession, TokenCache } from "@repo/platform/engine/lib/cloud/types";

const h = vi.hoisted(() => ({
  sessions: new Map<string, string>(), tokens: new Map<string, TokenCache>(),
  api: { api: "https://cloud.example.test" },
  fetch: vi.fn(), clear: vi.fn(), invalidate: vi.fn(), set: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: { settings: {
  findByUser: async (userId: string) => ({ cloudSessionToken: h.sessions.get(userId) }),
  findOrgOwnerCloudLink: async (org: string) => org === "local-org" ? { userId: "local-owner" } : null,
  setCloudSession: async (userId: string, sealed: string) => { h.sessions.set(userId, sealed); },
  clearCloudSession: h.clear,
} } }));
vi.mock("@repo/platform/engine/config/env", () => ({
  cloudRuntimeTarget: h.api, cloudRuntimeTargetId: "test",
  env: { CLOUD_MODE: false, DEPLOY_MODE: "docker", BETTER_AUTH_SECRET: "test-cloud-connection-encryption-secret" },
}));
vi.mock("@repo/platform/engine/lib/cache-store/index", () => ({ cacheStore: async () => ({
  get: async (key: string) => h.tokens.get(key), set: h.set, invalidateByPrefix: h.invalidate,
}) }));
vi.mock("@repo/platform/engine/modules/github/github.auth", () => ({ invalidateUserGitHubCache: vi.fn() }));
import { encrypt, decrypt } from "@repo/platform/engine/lib/encryption";
import { cloudFetch, cloudFetchAsOrgOwner, readCloudSession } from "@repo/platform/engine/lib/cloud/transport";
import { storeCloudSession, isCloudConnected, clearCloudSession } from "@repo/platform/engine/lib/cloud/session";
import { cloudClient } from "@repo/platform/engine/lib/cloud/client";

const first: StoredCloudSession = { token: "session-one", apiUrl: "https://cloud.example.test", userId: "cloud-user", organizationId: "cloud-org" };
const save = (session = first, userId = "local-owner") => h.sessions.set(userId, encrypt(JSON.stringify(session)));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const account = () => json({ user: { id: first.userId, organizationId: first.organizationId } });
const token = (namespace = "owned-namespace", value = "provider-token") => json({ data: { token: value, namespace, expiresAt: new Date(Date.now() + 1800000).toISOString() } });

beforeEach(() => {
  vi.resetAllMocks(); h.sessions.clear(); h.tokens.clear(); h.api.api = first.apiUrl;
  vi.stubGlobal("fetch", h.fetch);
  h.fetch.mockResolvedValue(account());
  h.clear.mockImplementation(async (id: string, expected: string) => {
    if (h.sessions.get(id) === expected) h.sessions.delete(id);
  });
  h.set.mockImplementation(async (key: string, entry: TokenCache) => { h.tokens.set(key, entry); });
  h.invalidate.mockImplementation(async (prefix: string) => {
    for (const key of h.tokens.keys()) if (key.startsWith(prefix)) h.tokens.delete(key);
  });
  save();
});
afterEach(() => vi.unstubAllGlobals());

describe("pinned Cloud identity", () => {
  it("verifies and seals the credential with its Cloud API, user and organization", async () => {
    await storeCloudSession("local-owner", "new-session");
    expect(JSON.parse(decrypt(h.sessions.get("local-owner")!))).toEqual({ ...first, token: "new-session" });
    expect(h.sessions.get("local-owner")).not.toContain("new-session");
    expect(h.fetch).toHaveBeenCalledWith(`${first.apiUrl}/api/cloud/account`, expect.objectContaining({ redirect: "error" }));
    expect(h.invalidate).toHaveBeenCalledWith("local-owner:");
  });

  it("does not replace a working connection with an unverified account", async () => {
    h.fetch.mockResolvedValue(json({ user: { id: "missing-org" } }));
    await expect(storeCloudSession("local-owner", "invalid-session")).rejects.toMatchObject({ code: "CLOUD_IDENTITY_UNVERIFIED" });
    expect(await readCloudSession("local-owner")).toEqual(first);
  });

  it("pins authorization headers and refuses a different configured Cloud endpoint", async () => {
    await cloudFetchAsOrgOwner("local-org", "/api/system/servers", {
      headers: { Authorization: "Bearer forged", "X-Organization-Id": "foreign-org" },
    });
    const init = h.fetch.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${first.token}`);
    expect(new Headers(init.headers).get("X-Organization-Id")).toBe(first.organizationId);
    h.fetch.mockClear();
    h.api.api = "https://different-cloud.example.test";
    expect(await cloudFetch("local-owner", "/api/system/servers")).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("rejects a changed user or organization even when the account endpoint succeeds", async () => {
    h.fetch.mockResolvedValueOnce(json({ user: { id: "other-user", organizationId: first.organizationId } }));
    expect(await isCloudConnected("local-owner")).toBe(false);
    h.fetch.mockResolvedValueOnce(json({ user: { id: first.userId, organizationId: "other-org" } }));
    expect(await isCloudConnected("local-owner")).toBe(false);
    expect(h.clear).not.toHaveBeenCalled();
  });

  it("does not let a stale identity 401 erase a newly connected session", async () => {
    let respond!: (response: Response) => void;
    let sent!: () => void;
    const started = new Promise<void>(done => { sent = done; });
    h.fetch.mockImplementationOnce(() => { sent(); return new Promise<Response>(done => { respond = done; }); });
    const checking = isCloudConnected("local-owner");
    await started;
    save({ ...first, token: "new-session", userId: "new-owner" });
    respond(json({}, 401));
    expect(await checking).toBe(false);
    expect((await readCloudSession("local-owner"))?.token).toBe("new-session");
    expect(h.clear).not.toHaveBeenCalled();
  });

  it("retains credentials on endpoint-specific 401 and transient account errors", async () => {
    h.fetch.mockResolvedValueOnce(json({}, 401));
    expect((await cloudFetch("local-owner", "/api/cloud/token"))?.status).toBe(401);
    h.fetch.mockResolvedValueOnce(json({}, 503));
    expect(await isCloudConnected("local-owner")).toBe(false);
    expect(await readCloudSession("local-owner")).toEqual(first);
    expect(h.clear).not.toHaveBeenCalled();
  });

  it("uses compare-and-swap when clearing the stored credential", async () => {
    const sealed = h.sessions.get("local-owner");
    await clearCloudSession("local-owner", first);
    expect(h.clear).toHaveBeenCalledWith("local-owner", sealed);
    expect(await readCloudSession("local-owner")).toBeNull();
  });
});

describe("namespace-token isolation", () => {
  it.each(["token", "userId", "organizationId", "apiUrl"] as const)("mints separately after %s changes", async field => {
    h.fetch.mockResolvedValueOnce(token());
    const client = cloudClient({ organizationId: "local-org" });
    expect(await client.token()).toEqual({ namespace: "owned-namespace", token: "provider-token" });
    expect(await client.token()).toEqual({ namespace: "owned-namespace", token: "provider-token" });
    const changed = { ...first, [field]: field === "apiUrl" ? "https://other-cloud.example.test" : `changed-${field}` };
    if (field === "apiUrl") h.api.api = changed.apiUrl;
    save(changed);
    h.fetch.mockResolvedValueOnce(token("new-namespace", "new-provider-token"));
    expect(await client.token()).toEqual({ namespace: "new-namespace", token: "new-provider-token" });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.tokens.size).toBe(2);
  });

  it("discards a token response when the connection changes while minting", async () => {
    h.fetch.mockImplementationOnce(async () => {
      save({ ...first, token: "replacement", organizationId: "replacement-org" });
      return token();
    });
    expect(await cloudClient({ organizationId: "local-org" }).token()).toBeNull();
    expect(h.set).not.toHaveBeenCalled();
  });

  it("does not cache expired or malformed provider credentials", async () => {
    h.fetch.mockResolvedValueOnce(json({ data: { token: "expired", namespace: "owned", expiresAt: "2000-01-01T00:00:00Z" } }));
    expect(await cloudClient({ userId: "local-owner" }).token()).toBeNull();
    h.fetch.mockResolvedValueOnce(json({ data: { token: "", namespace: "owned", expiresAt: "invalid" } }));
    expect(await cloudClient({ userId: "local-owner" }).token()).toBeNull();
    expect(h.set).not.toHaveBeenCalled();
  });

  it("uses whole-second cache expiry and discards a connection changed during the cache write", async () => {
    h.fetch.mockResolvedValueOnce(json({ data: { token: "short-lived", namespace: "owned", expiresAt: new Date(Date.now() + 10_700).toISOString() } }));
    h.set.mockImplementationOnce(async () => { save({ ...first, token: "replacement" }); });
    expect(await cloudClient({ userId: "local-owner" }).token()).toBeNull();
    const ttl = h.set.mock.calls[0]![2] as number;
    expect(Number.isInteger(ttl)).toBe(true);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10);
  });
});
