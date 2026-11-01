import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase } from "@repo/db/factory";
import { createRepositories } from "@repo/db/factory";
import { createEncryption } from "@repo/db/encryption";
import * as s from "@repo/db/schema";
import type { ExecutionContext } from "../../../context";
const h = vi.hoisted(() => ({
  repos: {} as any,
  background: [] as Array<() => Promise<unknown>>,
  route: vi.fn(),
  execute: vi.fn(),
  commands: vi.fn(),
  authorize: vi.fn(async (ctx: any) => ctx),
}));
vi.mock("@repo/db", () => ({
  get repos() {
    return h.repos;
  },
  withAdvisoryLock: async (_key: string, work: () => Promise<unknown>) => work(),
  tryAcquireAdvisoryLock: async () => ({ release: async () => {} }),
}));
vi.mock("../../lib/audit-emitter", () => ({
  audit: { recordAsync: vi.fn() },
  operationAuditContext: (ctx: unknown) => ctx,
}));
vi.mock("../../config", () => ({ env: { CLOUD_MODE: false } }));
vi.mock("../../lib/authorization", () => ({ authorization: { authorize: h.authorize } }));
vi.mock("../../lib/box-org", () => ({ isLocalHostRow: async (server: any) => server.isLocal }));
vi.mock("../../lib/cloud-workspace-lock", () => ({
  withCloudWorkspaceActivity: async (_id: unknown, work: () => Promise<unknown>) => work(),
}));
vi.mock("../../lib/background-work", () => ({
  deferBackgroundWork: (work: () => Promise<unknown>) => {
    h.background.push(work);
    return Promise.resolve();
  },
}));
vi.mock("../../lib/server-execution", () => ({ withServerExecution: h.execute }));
vi.mock("../../lib/credential-encryption", () => ({
  decryptSecretField: (value: string) => value.slice(5),
  encryptSecretField: (value: string) => `enc1:${value}`,
}));
vi.mock("../credentials/verify", () => ({
  hasVerifier: () => true,
  verifyCredentialValues: async () => ({ ok: true }),
}));
vi.mock("../domains/project-route.service", () => ({ reapplyProjectLiveRoutes: h.route }));
import * as ingress from "./service";
let db: Awaited<ReturnType<typeof createDatabase>>;
let calls: Array<{ path: string; method: string; body: any }>,
  config: any,
  records: any[],
  apps: any[],
  fail: string | null;
const ctx = {
  organizationId: "org",
  userId: "owner",
  role: "owner",
  sessionKind: "native",
  scopeMode: "fixed",
} as ExecutionContext;
const input = {
  serverId: "server",
  credentialId: "credential",
  accountId: "account",
  name: "Existing",
  tunnelId: "tunnel",
  connector: "existing" as const,
  defaultForDomains: true,
  defaultAccessPolicyId: "policy",
};
function response(result: unknown) {
  return new Response(JSON.stringify({ success: true, result }));
}
beforeAll(async () => {
  db = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  h.repos = createRepositories(db.db, createEncryption("ingress-test-only-encryption-key"));
  await db.db.insert(s.organization).values([
    { id: "org", name: "One" },
    { id: "other", name: "Other" },
  ]);
  await db.db.insert(s.servers).values([
    { id: "server", organizationId: "org", sshHost: "192.0.2.1", isLocal: true },
    { id: "foreign", organizationId: "other", sshHost: "192.0.2.2" },
  ]);
  await db.db.insert(s.credential).values({
    id: "credential",
    organizationId: "org",
    provider: "cloudflare",
    name: "Cloudflare",
    secretsEnc: 'enc1:{"apiToken":"test-secret"}',
  });
  await db.db
    .insert(s.projectGroup)
    .values({ id: "group", organizationId: "org", name: "App", slug: "app" });
  await db.db.insert(s.project).values({
    id: "project",
    groupId: "group",
    organizationId: "org",
    name: "App",
    slug: "app",
    serverId: "server",
    activeDeploymentId: "deployment",
  });
}, 30_000);
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db?.close();
});
beforeEach(async () => {
  await db.db.delete(s.ingressHostname);
  await db.db.delete(s.ingressConnection);
  await db.db.delete(s.domain);
  h.background = [];
  h.route.mockReset();
  h.execute.mockReset();
  h.authorize.mockClear();
  calls = [];
  records = [];
  apps = [];
  fail = null;
  config = {
    ingress: [
      { hostname: "manual.example.test", service: "http://elsewhere" },
      { service: "http_status:404" },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname.replace("/client/v4", "");
      const method = init.method ?? "GET",
        body = init.body ? JSON.parse(init.body as string) : null;
      calls.push({ path, method, body });
      if (fail === path && method !== "GET")
        return new Response(
          JSON.stringify({ success: false, errors: [{ message: "Try again" }] }),
          { status: 503 },
        );
      if (path.endsWith("/access/policies"))
        return response([{ id: "policy", name: "Team", decision: "allow" }]);
      if (path.endsWith("/access/policies/policy"))
        return response({ id: "policy", name: "Team", decision: "allow" });
      if (path.endsWith("/access/organizations"))
        return response({ auth_domain: "team.cloudflareaccess.com" });
      if (path.endsWith("/access/apps")) {
        if (method === "POST") {
          const app = { id: "application", aud: "audience", ...body };
          apps.push(app);
          return response(app);
        }
        // An unrelated launcher has no hostname but must not block publication.
        return response([...apps, { id: "launcher", type: "app_launcher", name: "Team" }]);
      }
      if (path.endsWith("/access/apps/application/policies"))
        return response(apps[0]?.policies ?? []);
      if (path.endsWith("/access/apps/application")) {
        if (method === "GET") return response(apps[0]);
        if (method === "DELETE") apps = [];
        return response({});
      }
      if (path.endsWith("/configurations")) {
        if (method === "PUT") config = body.config;
        return response({ config });
      }
      if (path.endsWith("/cfd_tunnel/tunnel"))
        return response({
          id: "tunnel",
          name: "Existing",
          config_src: "cloudflare",
          status: "healthy",
        });
      if (path === "/zones")
        return response([
          { id: "zone", name: "example.test", account: { id: "account", name: "Account" } },
        ]);
      if (path === "/zones/zone/dns_records") {
        if (method === "POST") {
          const record = { id: "record", ...body };
          records.push(record);
          return response(record);
        }
        return response(records);
      }
      if (path === "/zones/zone/dns_records/record") {
        if (method === "GET")
          return records.length
            ? response(records[0])
            : new Response(JSON.stringify({ success: false, errors: [{ message: "Not found" }] }), {
                status: 404,
              });
        records = [];
        return response({});
      }
      throw new Error(`Unexpected fixture route ${method} ${path}`);
    }),
  );
});
async function setup() {
  const c = await ingress.connect(ctx, input);
  await h.background.shift()!();
  const row = await h.repos.ingress.get("org", c.id);
  expect(row.status).toBe("ready");
  return row;
}
describe("domain lifecycle through the real database and Cloudflare adapter", () => {
  it("publishes protected project domains after edge setup, then cleans only owned resources after deletion", async () => {
    const c = await setup();
    const domain = await h.repos.domain.create({
      projectId: "project",
      hostname: "app.example.test",
      domainType: "custom",
    });
    let host = await h.repos.ingress.forDomain(domain.id);
    await ingress.reconcileHostname(host);
    host = await h.repos.ingress.forDomain(domain.id);
    expect(host.status).toBe("ready");
    expect(apps).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(h.route).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
    const appIndex = calls.findIndex((r) => r.method === "POST" && r.path.endsWith("/access/apps")),
      ruleIndex = calls.findIndex((r) => r.method === "PUT" && r.path.endsWith("/configurations")),
      dnsIndex = calls.findIndex((r) => r.method === "POST" && r.path.endsWith("/dns_records"));
    expect(appIndex).toBeLessThan(ruleIndex);
    expect(ruleIndex).toBeLessThan(dnsIndex);
    await h.repos.domain.remove(domain.id);
    expect((await h.repos.ingress.host(host.id)).domainId).toBeNull();
    await ingress.reconcileHostname(await h.repos.ingress.host(host.id));
    expect(records).toHaveLength(0);
    expect(apps).toHaveLength(0);
    expect(config.ingress).toEqual([
      { hostname: "manual.example.test", service: "http://elsewhere" },
      { service: "http_status:404" },
    ]);
    expect(await h.repos.ingress.host(host.id)).toBeUndefined();
    expect(await h.repos.ingress.get("org", c.id)).toBeDefined();
    const deletes = calls.filter((r) => r.method === "DELETE").map((r) => r.path);
    expect(deletes).toEqual([
      "/zones/zone/dns_records/record",
      "/accounts/account/access/apps/application",
    ]);
  });
  it("leaves a durable retry after Access or edge failure without publishing DNS", async () => {
    await setup();
    const domain = await h.repos.domain.create({
      projectId: "project",
      hostname: "retry.example.test",
      domainType: "custom",
    });
    let host = await h.repos.ingress.forDomain(domain.id);
    fail = "/accounts/account/access/apps";
    await ingress.reconcileHostname(host);
    host = await h.repos.ingress.host(host.id);
    expect(host).toMatchObject({ status: "error", phase: "access", attempts: 1 });
    expect(records).toHaveLength(0);
    expect(config.ingress).toHaveLength(2);
    fail = null;
    h.route.mockImplementationOnce(async (_p, _old, opts) => opts.onWarning("Edge unavailable"));
    await ingress.reconcileHostname(host);
    host = await h.repos.ingress.host(host.id);
    expect(host.status).toBe("error");
    expect(records).toHaveLength(0);
    expect(apps).toHaveLength(1);
    h.route.mockReset();
    await ingress.reconcileHostname(host);
    expect((await h.repos.ingress.host(host.id)).status).toBe("ready");
    expect(apps).toHaveLength(1);
    expect(records).toHaveLength(1);
  });
  it("preserves existing policies when defaults change and refuses foreign resources before external calls", async () => {
    const c = await setup();
    const d = await h.repos.domain.create({
      projectId: "project",
      hostname: "policy.example.test",
      domainType: "custom",
    });
    await ingress.update(ctx, { id: c.id, defaultForDomains: false, defaultAccessPolicyId: null });
    expect((await h.repos.ingress.forDomain(d.id)).accessPolicyId).toBe("policy");
    const count = calls.length;
    await expect(ingress.connect({ ...ctx, organizationId: "other" }, input)).rejects.toThrow(
      /not found/,
    );
    await expect(
      ingress.setDomain(
        { ...ctx, organizationId: "other" },
        { domainId: d.id, connectionId: c.id },
      ),
    ).rejects.toThrow(/not found/);
    expect(calls).toHaveLength(count);
    expect(h.authorize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceType: "server", action: "admin" }),
    );
  });
  it("rejects native host execution policy before provisioning any Cloudflare resource", async () => {
    vi.stubEnv("OPENSHIP_NATIVE", "true");
    vi.stubEnv("OPENSHIP_NATIVE_JOBS", "true");
    vi.stubEnv("OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION", "false");
    await expect(ingress.connect(ctx, input)).rejects.toMatchObject({
      code: "HOST_EXECUTION_DISABLED",
    });
    expect(calls).toHaveLength(0);
    expect(await h.repos.ingress.list("org")).toEqual([]);
    vi.unstubAllEnvs();
  });
});

describe("cancelled and stale reconciliation recovery", () => {
  it.each(["null", "absent", "empty", "unreadable"] as const)(
    "recovers cancellation after a lost tunnel create response (%s configuration)",
    async (configuration) => {
      let remote: { id: string; name: string; config_src: string } | null = null;
      const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
        const path = new URL(url).pathname,
          method = init.method ?? "GET";
        if (path.endsWith("/cfd_tunnel")) {
          if (method === "POST") {
            remote = { id: "created-tunnel", ...JSON.parse(init.body as string) };
            throw new Error("response lost");
          }
          return response(remote ? [remote] : []);
        }
        if (path.endsWith("/configurations")) {
          if (configuration === "absent")
            return new Response(
              JSON.stringify({ success: false, errors: [{ message: "Not found" }] }),
              { status: 404 },
            );
          return response({
            config:
              configuration === "null" ? null : configuration === "empty" ? { ingress: [] } : {},
          });
        }
        if (path.endsWith("/cfd_tunnel/created-tunnel")) {
          if (method === "DELETE") {
            remote = null;
            return response({});
          }
          return response(remote);
        }
        throw new Error("Unexpected fixture request");
      });
      vi.stubGlobal("fetch", fetch);
      const c = await ingress.connect(ctx, {
        ...input,
        tunnelId: undefined,
        defaultAccessPolicyId: undefined,
        defaultForDomains: false,
      });
      await h.background.shift()!();
      expect(await h.repos.ingress.get("org", c.id)).toMatchObject({
        status: "error",
        tunnelId: null,
      });
      expect(remote).not.toBeNull();
      await ingress.disconnect(ctx, c.id);
      await h.background.shift()!();
      if (configuration === "unreadable") {
        expect(remote).not.toBeNull();
        expect(await h.repos.ingress.get("org", c.id)).toMatchObject({
          status: "removing",
          error: expect.stringContaining("configuration could not be read"),
        });
      } else {
        expect(remote).toBeNull();
        expect(await h.repos.ingress.get("org", c.id)).toBeUndefined();
      }
      expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(h.execute).not.toHaveBeenCalled();
    },
  );
  it("does not let a queued old sweep override a newer failure's backoff", async () => {
    await setup();
    const d = await h.repos.domain.create({
      projectId: "project",
      hostname: "stale.example.test",
      domainType: "custom",
    });
    const snapshot = await h.repos.ingress.forDomain(d.id);
    await h.repos.ingress.updateHost(snapshot.id, {
      status: "error",
      error: "Newer failure",
      nextAttemptAt: new Date(Date.now() + 60_000),
    });
    // Explicit timestamps make the queued-worker ordering independent of clock resolution.
    snapshot.nextAttemptAt = new Date(0);
    const count = calls.length;
    await ingress.reconcileHostname(snapshot);
    expect(calls).toHaveLength(count);
    expect(await h.repos.ingress.host(snapshot.id)).toMatchObject({
      status: "error",
      error: "Newer failure",
    });
  });
});
