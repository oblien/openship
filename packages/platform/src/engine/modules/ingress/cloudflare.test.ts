import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngressConnection, IngressHostname } from "@repo/db";
import type { IngressOwnership } from "@repo/db/schema";
import { canonical, CloudflareIngress, mergeIngress, type TunnelConfig } from "./cloudflare";
const c = {
  id: "connection",
  accountId: "account",
  tunnelId: "tunnel",
  edgePort: 80,
} as IngressConnection;
const h = { id: "host", hostname: "app.example.test", accessPolicyId: null } as IngressHostname;
const terminal = { service: "http_status:404" };
let config: TunnelConfig,
  records: any[],
  apps: any[],
  calls: Array<{ path: string; method: string; body: any }>;
let failAfterWrite: string | null, failBeforeWrite: string | null;
function ok(result: unknown) {
  return new Response(JSON.stringify({ success: true, result }), {
    headers: { "content-type": "application/json" },
  });
}
beforeEach(() => {
  config = {
    originRequest: { connectTimeout: 20 },
    ingress: [
      {
        hostname: "manual.example.test",
        service: "http://localhost:3000",
        originRequest: { httpHostHeader: "manual.example.test" },
      },
      terminal,
    ],
  };
  records = [];
  apps = [];
  calls = [];
  failAfterWrite = null;
  failBeforeWrite = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = new URL(url),
        path = u.pathname.replace("/client/v4", "");
      const method = init.method ?? "GET",
        body = init.body ? JSON.parse(init.body as string) : null;
      calls.push({ path, method, body });
      if (failBeforeWrite === path && method !== "GET") throw new Error("connection closed");
      let result: unknown;
      if (path.endsWith("/configurations")) {
        if (method === "PUT") config = body.config;
        result = { config };
      } else if (path === "/zones")
        result = [{ id: "zone", name: "example.test", account: { id: "account" } }];
      else if (path === "/zones/zone/dns_records") {
        if (method === "POST") {
          result = { id: `dns-${records.length}`, ...body };
          records.push(result);
        } else result = records.filter((r) => r.name === u.searchParams.get("name"));
      } else if (path.startsWith("/zones/zone/dns_records/")) {
        if (method === "GET") {
          result = records.find((r) => r.id === path.split("/").at(-1));
          if (!result)
            return new Response(
              JSON.stringify({ success: false, errors: [{ message: "Not found" }] }),
              { status: 404 },
            );
        } else {
          records = records.filter((r) => r.id !== path.split("/").at(-1));
          result = {};
        }
      } else if (path.endsWith("/access/organizations"))
        result = { auth_domain: "myteam.cloudflareaccess.com" };
      else if (path.includes("/access/policies/"))
        result = { id: path.split("/").at(-1), name: "Team", decision: "allow" };
      else if (path.endsWith("/access/apps")) {
        if (method === "POST") {
          result = { id: `app-${apps.length}`, aud: "audience", ...body };
          apps.push(result);
        } else result = apps;
      } else if (path.includes("/access/apps/") && path.endsWith("/policies")) {
        const app = apps.find((a) => a.id === path.split("/").at(-2));
        result = app?.policies ?? [];
      } else if (path.includes("/access/apps/")) {
        const id = path.split("/").at(-1);
        if (method === "GET") {
          result = apps.find((a) => a.id === id);
        } else if (method === "DELETE") {
          apps = apps.filter((a) => a.id !== id);
          result = {};
        } else {
          const index = apps.findIndex((a) => a.id === id);
          apps[index] = { ...apps[index], ...body };
          result = apps[index];
        }
      } else throw new Error(`Unexpected request ${method} ${path}`);
      if (failAfterWrite === path && method !== "GET") {
        failAfterWrite = null;
        throw new Error("response lost");
      }
      return ok(result);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
function ledger(seed: IngressOwnership = {}) {
  let stored = structuredClone(seed);
  return {
    get value() {
      return stored;
    },
    save: vi.fn(async (value: IngressOwnership) => {
      stored = structuredClone(value);
    }),
  };
}
describe("Cloudflare owned ingress merge", () => {
  it("preserves unrelated rules, global origin options and catch-all in order", () => {
    const rule = { hostname: h.hostname, service: "http://127.0.0.1:80" };
    const merged = mergeIngress(config, h.hostname, {}, rule);
    expect(merged.originRequest).toEqual(config.originRequest);
    expect(merged.ingress).toEqual([config.ingress[0], rule, terminal]);
    expect(config.ingress).toHaveLength(2);
  });
  it("refuses pre-existing, duplicate, wildcard-shadowed and edited rules", () => {
    const rule = { hostname: h.hostname, service: "http://127.0.0.1:80" };
    for (const ingress of [
      [rule, terminal],
      [rule, rule, terminal],
      [{ hostname: "*.example.test", service: "http://elsewhere" }, terminal],
    ])
      expect(() => mergeIngress({ ingress }, h.hostname, {}, rule)).toThrow(/outside|wildcard/);
    expect(() =>
      mergeIngress(
        { ingress: [{ ...rule, service: "http://manual" }, terminal] },
        h.hostname,
        { rule },
        null,
      ),
    ).toThrow(/outside/);
  });
  it("rejects malformed/catch-all-free configuration before any write", () => {
    expect(() => mergeIngress({ ingress: [] }, h.hostname, {}, null)).toThrow(/catch-all/);
    expect(() =>
      mergeIngress(
        { ingress: [{ hostname: "elsewhere.test", service: "http://localhost" }] },
        h.hostname,
        {},
        null,
      ),
    ).toThrow(/catch-all/);
  });
  it("recovers a lost tunnel PUT response using persisted intent", async () => {
    const api = new CloudflareIngress("secret", "account"),
      state = ledger();
    failAfterWrite = "/accounts/account/cfd_tunnel/tunnel/configurations";
    await expect(api.rule(h, c, state.value, state.save)).rejects.toThrow(/could not be reached/);
    expect(state.value.nextRule).toBeDefined();
    await api.rule(h, c, state.value, state.save);
    expect(config.ingress.filter((r) => r.hostname === h.hostname)).toHaveLength(1);
    expect(calls.filter((r) => r.method === "PUT")).toHaveLength(1);
  });
});
describe("DNS and Access ownership", () => {
  it("creates a proxied tunnel CNAME and recovers a lost creation response without duplicates", async () => {
    const api = new CloudflareIngress("secret", "account"),
      state = ledger();
    failAfterWrite = "/zones/zone/dns_records";
    await expect(api.dns(h, c, state.value, state.save)).rejects.toThrow();
    expect(state.value).toMatchObject({ zoneId: "zone", dnsIntent: true });
    await api.dns(h, c, state.value, state.save);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "CNAME",
      content: "tunnel.cfargotunnel.com",
      proxied: true,
      comment: "Managed by Openship (host)",
    });
    expect(state.value.dnsId).toBe(records[0].id);
  });
  it("does not adopt a foreign DNS record, even when its value already matches", async () => {
    records = [
      {
        id: "foreign",
        name: h.hostname,
        type: "CNAME",
        content: "tunnel.cfargotunnel.com",
        proxied: true,
      },
    ];
    const state = ledger();
    await expect(
      new CloudflareIngress("secret", "account").dns(h, c, state.value, state.save),
    ).rejects.toThrow(/will not replace/);
    expect(calls.some((r) => r.method !== "GET")).toBe(false);
  });
  it("retains a manually changed owned record on delete", async () => {
    records = [
      {
        id: "ours",
        name: h.hostname,
        type: "CNAME",
        content: "manual.example.test",
        proxied: true,
        comment: "Managed by Openship (host)",
      },
    ];
    const state = ledger({ zoneId: "zone", dnsId: "ours" });
    await expect(
      new CloudflareIngress("secret", "account").dns(h, c, state.value, state.save, true),
    ).rejects.toThrow(/changed outside/);
    expect(records).toHaveLength(1);
  });
  it("scopes Access to this hostname and chosen reusable policy, with origin JWT verification", async () => {
    const host = { ...h, accessPolicyId: "policy" },
      state = ledger(),
      api = new CloudflareIngress("secret", "account");
    await api.access(host, state.value, state.save);
    expect(apps[0]).toMatchObject({
      type: "self_hosted",
      domain: h.hostname,
      destinations: [{ type: "public", uri: h.hostname }],
      policies: [{ id: "policy", precedence: 1 }],
    });
    await api.rule(host, c, state.value, state.save);
    expect(config.ingress.find((r) => r.hostname === h.hostname)?.originRequest).toEqual({
      access: { required: true, teamName: "myteam", audTag: ["audience"] },
    });
  });
  it("publishes a protected hostname alongside unrelated applications without a domain", async () => {
    const foreign = [
      { id: "launcher", type: "app_launcher", name: "Team launcher" },
      {
        id: "private",
        type: "self_hosted",
        destinations: [{ type: "private", cidr: "10.0.0.0/8" }],
      },
      { id: "public", type: "self_hosted", destinations: [{ type: "public", uri: "other.test" }] },
    ];
    apps = structuredClone(foreign);
    const host = { ...h, accessPolicyId: "policy" },
      state = ledger(),
      api = new CloudflareIngress("secret", "account");

    await api.access(host, state.value, state.save);
    await api.rule(host, c, state.value, state.save);
    await api.dns(host, c, state.value, state.save);

    expect(apps.slice(0, foreign.length)).toEqual(foreign);
    expect(apps).toHaveLength(foreign.length + 1);
    expect(state.value).toMatchObject({ appId: "app-3", appAud: "audience", dnsId: "dns-0" });
    expect(
      config.ingress.find((rule) => rule.hostname === host.hostname)?.originRequest,
    ).toMatchObject({
      access: { required: true, audTag: ["audience"] },
    });
    expect(records[0]).toMatchObject({ name: host.hostname, type: "CNAME", proxied: true });
  });

  it.each([
    { domain: "*.EXAMPLE.TEST/private" },
    { self_hosted_domains: [h.hostname] },
    { self_hosted_domains: ["*.example.test/private"] },
    { destinations: [{ type: "public", uri: `${h.hostname}/private` }] },
    { destinations: [{ type: "public", uri: "*.EXAMPLE.TEST" }] },
  ])("still refuses foreign Access overlap through %j", async (addresses) => {
    apps = [{ id: "foreign", type: "self_hosted", name: "Manual", ...addresses }];
    const state = ledger();
    await expect(
      new CloudflareIngress("secret", "account").access(
        { ...h, accessPolicyId: "policy" },
        state.value,
        state.save,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "INGRESS_PROVIDER_CONFLICT" });
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
    expect(state.value.appIntent).toBeUndefined();
    expect(apps).toHaveLength(1);
  });

  it.each([
    { domain: 42 },
    { domain: null },
    { self_hosted_domains: h.hostname },
    { self_hosted_domains: [null] },
    { destinations: { type: "public", uri: h.hostname } },
    { destinations: [null] },
    { destinations: [{ type: "public", uri: 42 }] },
  ])(
    "blocks publication with a useful provider error for malformed addresses %j",
    async (addresses) => {
      apps = [{ id: "foreign", type: "self_hosted", name: "Manual", ...addresses }];
      const state = ledger();
      await expect(
        new CloudflareIngress("secret", "account").access(
          { ...h, accessPolicyId: "policy" },
          state.value,
          state.save,
        ),
      ).rejects.toMatchObject({
        statusCode: 502,
        code: "CLOUDFLARE_API_ERROR",
        message: expect.stringMatching(/invalid Access application.*(?:domain|destinations)/),
      });
      expect(calls.some((call) => call.method !== "GET")).toBe(false);
      expect(state.value).toEqual({});
    },
  );

  it.each(["access", "removeAccess"] as const)(
    "does not %s an owned application whose domain was removed",
    async (operation) => {
      const host = { ...h, accessPolicyId: "policy" },
        state = ledger(),
        api = new CloudflareIngress("secret", "account");
      await api.access(host, state.value, state.save);
      delete apps[0].domain;
      calls = [];

      await expect(api[operation](host, state.value, state.save)).rejects.toMatchObject({
        statusCode: 409,
        code: "INGRESS_PROVIDER_CONFLICT",
      });
      expect(calls.some((call) => call.method !== "GET")).toBe(false);
      expect(apps).toHaveLength(1);
      expect(state.value.appId).toBe(apps[0].id);
    },
  );

  it("does not create a second Access application after a lost response", async () => {
    const host = { ...h, accessPolicyId: "policy" },
      state = ledger(),
      api = new CloudflareIngress("secret", "account");
    failAfterWrite = "/accounts/account/access/apps";
    await expect(api.access(host, state.value, state.save)).rejects.toThrow();
    await api.access(host, state.value, state.save);
    expect(apps).toHaveLength(1);
    expect(state.value.appId).toBe(apps[0].id);
  });
  it("refuses a foreign Access application and keeps owned apps with manually attached policies", async () => {
    const host = { ...h, accessPolicyId: "policy" },
      state = ledger(),
      api = new CloudflareIngress("secret", "account");
    apps = [
      {
        id: "foreign",
        domain: h.hostname,
        type: "self_hosted",
        name: "Manual",
        aud: "manual",
        policies: [{ id: "manual" }],
      },
    ];
    await expect(api.access(host, state.value, state.save)).rejects.toThrow(/existing Access/);
    apps = [];
    await api.access(host, state.value, state.save);
    apps[0].policies.push({ id: "manual" });
    await expect(api.removeAccess(host, state.value, state.save)).rejects.toThrow(/retained/);
    expect(apps).toHaveLength(1);
  });
  it("does not publish anything when Access fails and never deletes reusable policies", async () => {
    const host = { ...h, accessPolicyId: "policy" },
      state = ledger(),
      api = new CloudflareIngress("secret", "account");
    failBeforeWrite = "/accounts/account/access/apps";
    await expect(api.access(host, state.value, state.save)).rejects.toThrow();
    expect(records).toHaveLength(0);
    expect(config.ingress).toHaveLength(2);
    failBeforeWrite = null;
    await api.access(host, state.value, state.save);
    await api.removeAccess(host, state.value, state.save);
    expect(calls.some((r) => r.method === "DELETE" && r.path.includes("/policies/"))).toBe(false);
  });
});

describe("named tunnel recovery", () => {
  it("recovers a created tunnel after losing the response, and refuses foreign routes during removal", async () => {
    let saved: { id: string; name: string; config_src: string } | null = null;
    let tunnelConfig: TunnelConfig | null = null;
    let creates = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const path = new URL(url).pathname,
          method = init.method ?? "GET";
        if (path.endsWith("/cfd_tunnel")) {
          if (method === "POST") {
            creates++;
            saved = { id: "new-tunnel", ...JSON.parse(init.body as string) };
            throw new Error("response lost after tunnel creation");
          }
          return ok(saved ? [saved] : []);
        }
        if (path.endsWith("/configurations")) {
          if (method === "PUT") tunnelConfig = JSON.parse(init.body as string).config;
          return ok({ config: tunnelConfig });
        }
        if (path.endsWith("/cfd_tunnel/new-tunnel")) {
          if (method === "DELETE") {
            saved = null;
            return ok({});
          }
          return ok(saved);
        }
        throw new Error("Unexpected fixture request");
      }),
    );
    const api = new CloudflareIngress("secret", "account");
    await expect(api.createTunnel("Openship unique-setup")).rejects.toThrow();
    const recovered = await api.createTunnel("Openship unique-setup");
    expect(creates).toBe(1);
    await api.initializeTunnel(recovered.id);
    expect(tunnelConfig).toEqual({ ingress: [terminal] });
    tunnelConfig!.ingress.unshift({
      hostname: "foreign.example.test",
      service: "http://elsewhere",
    });
    await expect(api.deleteTunnel(recovered.id, recovered.name)).rejects.toThrow(
      /outside Openship/,
    );
    expect(saved).not.toBeNull();
    tunnelConfig!.ingress.shift();
    await api.deleteTunnel(recovered.id, recovered.name);
    expect(saved).toBeNull();
  });
  it("finishes owned rule and tunnel cleanup when the tunnel was already deleted", async () => {
    const state = ledger({ rule: { hostname: h.hostname, service: "http://127.0.0.1:80" } });
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: false, errors: [{ message: "Not found" }] }), {
          status: 404,
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const api = new CloudflareIngress("secret", "account");
    await api.rule(h, c, state.value, state.save, true);
    expect(state.value.rule).toBeUndefined();
    await api.deleteTunnel("tunnel", "Already gone");
    expect(fetch.mock.calls).toHaveLength(2);
  });
});

describe("interrupted protection and DNS changes", () => {
  it("cleans a created Access app after losing its response and disabling protection", async () => {
    const state = ledger(),
      api = new CloudflareIngress("secret", "account");
    failAfterWrite = "/accounts/account/access/apps";
    await expect(
      api.access({ ...h, accessPolicyId: "policy" }, state.value, state.save),
    ).rejects.toThrow();
    expect(apps).toHaveLength(1);
    expect(state.value.appNextPolicyId).toBe("policy");
    await api.removeAccess(h, state.value, state.save);
    expect(apps).toHaveLength(0);
    expect(state.value.appNextPolicyId).toBeUndefined();
  });
  it("retains both policy receipts when a policy update response is lost", async () => {
    const state = ledger(),
      api = new CloudflareIngress("secret", "account");
    await api.access({ ...h, accessPolicyId: "policy" }, state.value, state.save);
    failAfterWrite = `/accounts/account/access/apps/${state.value.appId}`;
    await expect(
      api.access({ ...h, accessPolicyId: "new-policy" }, state.value, state.save),
    ).rejects.toThrow();
    expect(state.value).toMatchObject({ appPolicyId: "policy", appNextPolicyId: "new-policy" });
    await api.removeAccess(h, state.value, state.save);
    expect(apps).toHaveLength(0);
  });
  it("retains a DNS record renamed outside Openship instead of forgetting its ownership", async () => {
    const state = ledger({ zoneId: "zone" }),
      api = new CloudflareIngress("secret", "account");
    await api.dns(h, c, state.value, state.save);
    records[0].name = "moved.example.test";
    await expect(api.dns(h, c, state.value, state.save)).rejects.toThrow(/moved or changed/);
    await expect(api.dns(h, c, state.value, state.save, true)).rejects.toThrow(/moved or changed/);
    expect(records).toHaveLength(1);
    expect(state.value.dnsId).toBe(records[0].id);
  });
  it("finishes DNS removal after its delete succeeded but the response was lost", async () => {
    const state = ledger({ zoneId: "zone" }),
      api = new CloudflareIngress("secret", "account");
    await api.dns(h, c, state.value, state.save);
    failAfterWrite = `/zones/zone/dns_records/${state.value.dnsId}`;
    await expect(api.dns(h, c, state.value, state.save, true)).rejects.toThrow();
    expect(records).toHaveLength(0);
    await api.dns(h, c, state.value, state.save, true);
    expect(state.value.dnsId).toBeUndefined();
  });
});
