import { beforeEach, describe, expect, it, vi } from "vitest";
import { withKeyedMutex } from "@repo/core";
import type { ExecutionContext } from "@repo/platform";

const h = vi.hoisted(() => ({
  stores: new Map<string, Map<string, string>>(),
  rows: new Map<string, any>(),
  exchange: vi.fn(),
  verify: vi.fn(),
  vm: vi.fn(),
}));
vi.mock("@repo/adapters", () => ({ Oblien: class { vm = h.vm; } }));
vi.mock("@repo/db", () => ({
  repos: {
    credential: {
      nameTaken: async (org: string, provider: string, _selector: unknown, name: string) =>
        [...h.rows.values()].some(
          (row) => row.organizationId === org && row.provider === provider && row.name === name,
        ),
      create: async (row: any) => {
        const value = { ...row, id: `connection-${h.rows.size}` };
        h.rows.set(value.id, value);
        return value;
      },
      findById: async (org: string, id: string) => {
        const row = h.rows.get(id);
        return row?.organizationId === org ? row : undefined;
      },
      update: async (org: string, id: string, patch: any) => {
        const row = h.rows.get(id);
        if (row?.organizationId !== org) return;
        Object.assign(row, patch);
        return row;
      },
    },
  },
}));
vi.mock("@repo/platform/engine/lib/cache-store", () => ({
  cacheStore: async (name: string) => {
    const map = h.stores.get(name) ?? new Map();
    h.stores.set(name, map);
    return {
      get: async (key: string) => map.get(key),
      set: async (key: string, value: string) => map.set(key, value),
      delete: async (key: string) => map.delete(key),
    };
  },
}));
vi.mock("@repo/platform/engine/lib/provision-lock", () => ({
  createProvisionLock: (key: string) => ({
    run: (work: () => Promise<unknown>) => withKeyedMutex(key, work),
  }),
}));
vi.mock("@repo/platform/engine/lib/public-url", () => ({
  resolveDashboardPublicUrl: () => "https://openship.example",
}));
vi.mock("@repo/platform/engine/lib/encryption", () => ({
  encrypt: (s: string) => Buffer.from(s).toString("base64"),
  decrypt: (s: string) => Buffer.from(s, "base64").toString(),
}));
vi.mock("@repo/platform/engine/modules/credentials/credential.service", () => ({
  readCredentialSecrets: (row: any) => JSON.parse(row.secretsEnc),
  writeCredentialSecrets: JSON.stringify,
  sanitizeCredential: ({ secretsEnc: _secret, ...row }: any) => row,
}));
vi.mock("@repo/platform/engine/modules/credentials/provider-api", () => ({
  providerJson: h.exchange,
  verifyProviderAccess: h.verify,
}));
import {
  beginConnectionAuthorization,
  completeConnectionAuthorization,
  getProviderAccess,
  getConnectionAccess,
} from "@repo/platform/engine/modules/credentials/connection-authorization";

const ctx = { organizationId: "org", userId: "user", sessionId: "session" } as ExecutionContext;
beforeEach(() => {
  h.stores.clear();
  h.rows.clear();
  vi.clearAllMocks();
  for (const provider of ["RAILWAY", "VERCEL", "OBLIEN"]) {
    vi.stubEnv(`OPENSHIP_CONNECTION_${provider}_CLIENT_ID`, "client");
    vi.stubEnv(`OPENSHIP_CONNECTION_${provider}_CLIENT_SECRET`, "client-secret");
  }
  vi.stubEnv("OPENSHIP_CONNECTION_VERCEL_INTEGRATION_SLUG", "openship");
  h.exchange.mockResolvedValue({
    access_token: "access-secret",
    refresh_token: "refresh-secret",
    expires_in: 3600,
  });
  h.verify.mockResolvedValue(undefined);
});

describe("organization platform authorization", () => {
  it.each([false, true])("uses a one-use session/workspace state and PKCE (desktop %s)", async (desktop) => {
    const started = await beginConnectionAuthorization(ctx, {
      provider: "railway",
      name: "Railway",
      desktop,
    });
    expect(started.state.startsWith("desktop.")).toBe(desktop);
    const url = new URL(started.url);
    expect(url.origin).toBe("https://backboard.railway.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://openship.example/connections/callback",
    );
    expect(JSON.stringify(started)).not.toContain("client-secret");
    await expect(
      completeConnectionAuthorization(
        { ...ctx, organizationId: "other" },
        { state: started.state, code: "code" },
      ),
    ).rejects.toMatchObject({ code: "CONNECTION_STATE_MISMATCH" });
    await expect(
      completeConnectionAuthorization(
        { ...ctx, sessionId: "other" },
        { state: started.state, code: "code" },
      ),
    ).rejects.toMatchObject({ code: "CONNECTION_STATE_MISMATCH" });
    expect(h.exchange).not.toHaveBeenCalled();
    const row = await completeConnectionAuthorization(ctx, { state: started.state, code: "code" });
    expect(row).toMatchObject({
      organizationId: "org",
      publicFields: { authorization: "oauth", tokenType: "oauth" },
    });
    expect(JSON.stringify(row)).not.toContain("access-secret");
    expect(new URLSearchParams(h.exchange.mock.calls[0][1].body).get("code_verifier")).toBeTruthy();
    await expect(
      completeConnectionAuthorization(ctx, { state: started.state, code: "code" }),
    ).rejects.toMatchObject({ code: "CONNECTION_STATE_EXPIRED" });
    expect(h.exchange).toHaveBeenCalledTimes(1);
  });
  it("consumes state even if the token exchange fails ambiguously", async () => {
    const started = await beginConnectionAuthorization(ctx, {
      provider: "railway",
      name: "Railway",
    });
    h.exchange.mockRejectedValueOnce(new Error("network"));
    await expect(
      completeConnectionAuthorization(ctx, { state: started.state, code: "code" }),
    ).rejects.toThrow("network");
    await expect(
      completeConnectionAuthorization(ctx, { state: started.state, code: "code" }),
    ).rejects.toMatchObject({ code: "CONNECTION_STATE_EXPIRED" });
  });
  it("uses Vercel integration grants and preserves the granted team scope", async () => {
    const started = await beginConnectionAuthorization(ctx, { provider: "vercel", name: "Vercel" });
    expect(new URL(started.url).pathname).toBe("/integrations/openship/new");
    h.exchange.mockResolvedValueOnce({ access_token: "integration-secret", team_id: "team-owned" });
    const row = await completeConnectionAuthorization(ctx, { state: started.state, code: "code" });
    expect(row.publicFields.teamId).toBe("team-owned");
    expect(h.exchange.mock.calls[0][0].href).toBe("https://api.vercel.com/v2/oauth/access_token");
  });
  it("serializes rotating refresh tokens and never selects another organization's connection", async () => {
    h.rows.set("existing", {
      id: "existing",
      organizationId: "org",
      provider: "railway",
      status: "active",
      publicFields: { tokenType: "oauth" },
      secretsEnc: JSON.stringify({
        apiToken: "expired",
        _authorization: "oauth",
        _expiresAt: "1",
        _refreshToken: "old-refresh",
      }),
    });
    await expect(getProviderAccess("other", "existing")).rejects.toMatchObject({ statusCode: 404 });
    const [a, b] = await Promise.all([
      getProviderAccess("org", "existing"),
      getProviderAccess("org", "existing"),
    ]);
    expect(a.secrets.apiToken).toBe("access-secret");
    expect(b).toEqual(a);
    expect(h.exchange).toHaveBeenCalledTimes(1);
    const form = new URLSearchParams(h.exchange.mock.calls[0][1].body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("old-refresh");
  });
});

it("binds a purchased VM to its initiating organization, locks its identity across refresh, and exposes no account token", async () => {
  const started = await beginConnectionAuthorization(ctx, { provider: "oblien", name: "Disposable server", setup: "new" });
  const url = new URL(started.url);
  expect(url.origin + url.pathname).toBe("https://api.oblien.com/v2/oauth/authorize");
  expect(url.searchParams.get("setup")).toBe("new");
  expect(url.searchParams.get("scope")).toBe("vm.read vm.runtime");
  expect(url.searchParams.get("resource")).toBe("https://api.oblien.com/v2");
  const token = { access_token: "disposable-access", refresh_token: "disposable-refresh", expires_in: 30, vm_id: "vm-a", scope: "vm.read vm.runtime" };
  h.exchange.mockResolvedValue(token);
  h.vm.mockReturnValue({ get: async () => ({ id: "vm-a", name: "Server A", namespace: null }) });
  const input = { state: started.state, code: "one-time" };
  await expect(completeConnectionAuthorization({ ...ctx, organizationId: "other" }, input)).rejects.toMatchObject({ code: "CONNECTION_STATE_MISMATCH" });
  const saved = await completeConnectionAuthorization(ctx, input);
  expect(saved.publicFields).toEqual({ authorization: "oauth", vmId: "vm-a", vmName: "Server A", namespace: "" });
  expect(JSON.stringify(saved)).not.toContain("disposable-access");
  expect(h.vm).toHaveBeenCalledWith("vm-a");
  const accepts = (provider: string): provider is "oblien" => provider === "oblien";
  await expect(getConnectionAccess("other", saved.id, accepts)).rejects.toThrow();
  h.exchange.mockResolvedValueOnce({ ...token, vm_id: "vm-b" });
  await expect(getConnectionAccess(ctx.organizationId, saved.id, accepts)).rejects.toThrow(/authorized VM changed/);
  expect(JSON.parse(h.rows.get(saved.id).secretsEnc)._refreshToken).toBe(token.refresh_token);
  h.exchange.mockResolvedValue({ ...token, access_token: "new-access", expires_in: 900 });
  const [first, second] = await Promise.all([getConnectionAccess(ctx.organizationId, saved.id, accepts), getConnectionAccess(ctx.organizationId, saved.id, accepts)]);
  expect(first.secrets.apiToken).toBe("new-access");
  expect(second.secrets.apiToken).toBe("new-access");
  expect(h.exchange).toHaveBeenCalledTimes(3);
});

it("requires runtime consent before attaching an Oblien grant", async () => {
  const started = await beginConnectionAuthorization(ctx, { provider: "oblien", name: "Read only" });
  h.exchange.mockResolvedValue({ access_token: "read", refresh_token: "refresh", expires_in: 900, vm_id: "vm-a", scope: "vm.read" });
  await expect(completeConnectionAuthorization(ctx, { state: started.state, code: "read-code" })).rejects.toMatchObject({ code: "SERVER_RUNTIME_CONSENT_REQUIRED" });
  expect(h.vm).not.toHaveBeenCalled();
  expect(h.rows.size).toBe(0);
});
