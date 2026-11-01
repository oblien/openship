import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { NotFoundError } from "@repo/core";
import { createRepositories, schema, type Repositories } from "@repo/db/factory";
import { createEncryption } from "@repo/db/encryption";
import type { DnsCertificateProvider, ManualCert, SslResult } from "@repo/adapters";
import type { ExecutionContext } from "@repo/platform";

// Real migrated repositories, engine, locks, encryption, verification and target
// resolution. DNS/CA and the remote SSL transport are the external boundaries.
const h = vi.hoisted(() => ({
  repos: {} as Repositories,
  revoked: false,
  txt: vi.fn(),
  prepare: vi.fn(),
  complete: vi.fn(),
  provision: vi.fn(),
  install: vi.fn(),
  resolve: vi.fn(),
  dispose: vi.fn(),
  activate: vi.fn(),
  installed: new Map<string, SslResult>(),
}));
vi.mock("@repo/db", async (original) => ({
  ...(await original<typeof import("@repo/db")>()),
  repos: h.repos,
  withAdvisoryLock: async <T>(_key: string, work: () => Promise<T>) => work(),
}));
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    resolveTxt = h.txt;
  },
}));
vi.mock("@repo/platform/engine/lib/authorization", () => ({
  authorization: {
    authorize: async (ctx: ExecutionContext) => {
      if (h.revoked || ctx.organizationId !== "org") throw new NotFoundError("Domain", "domain");
      return ctx;
    },
  },
}));
vi.mock("@repo/platform/engine/lib/platform-config", () => ({
  platform: () => ({
    target: "local",
    runtime: {},
    ssl: {
      installCert: () => {
        throw new Error("Must not install on the controller");
      },
    },
  }),
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/deployment-runtime")>()),
  resolveDeploymentPlatform: h.resolve,
  disposePlatform: h.dispose,
}));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: { probeReachable: async () => true },
}));
vi.mock("@repo/platform/engine/modules/dns/dns-credential.service", () => ({
  resolveDnsManager: async () => ({
    status: "matched",
    manager: {
      provider: { name: "cloudflare" },
      credentials: { apiToken: "secret-dns-token" },
      zone: { id: "zone", name: "example.com" },
    },
  }),
}));

import {
  cancelDnsChallenge,
  checkDnsChallenge,
  getDnsChallenge,
  startDnsChallenge,
} from "@repo/platform/engine/modules/domains/domain-dns-challenge.service";
import { drainBackgroundWork } from "@repo/platform/engine/lib/background-work";
import { decryptSecretField } from "@repo/platform/engine/lib/credential-encryption";

const hostname = "*.example.com";
const ctx = { organizationId: "org", userId: "operator", scopeMode: "fixed" } as ExecutionContext;
const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const encryption = createEncryption("dns-challenge-repository-test");
const certificate = { certPem: "CA-issued-certificate", keyPem: "private-certificate-key" };
const valid = (): SslResult => ({
  domain: hostname,
  verified: true,
  expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
  issuer: "Let's Encrypt",
});
const provider: DnsCertificateProvider = {
  directoryUrl: "https://ca.example/directory",
  createAccountKey: async () => "private-account-key",
  prepare: h.prepare,
  complete: h.complete,
};

beforeAll(async () => {
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../../../../packages/db/drizzle", import.meta.url)),
  });
  Object.assign(h.repos, createRepositories(db, encryption));
  await db
    .insert(schema.organization)
    .values({ id: "org", name: "Test", slug: "dns-test", createdAt: new Date() });
  await db
    .insert(schema.projectGroup)
    .values({ id: "group", organizationId: "org", name: "Web", slug: "web" });
  await db.insert(schema.servers).values([
    { id: "remote", organizationId: "org", sshHost: "192.0.2.5", isLocal: false },
    { id: "new-remote", organizationId: "org", sshHost: "192.0.2.6", isLocal: false },
  ]);
  await db.insert(schema.project).values({
    id: "project",
    organizationId: "org",
    groupId: "group",
    name: "Web",
    slug: "web",
    serverId: "remote",
  });
  await db.insert(schema.deployment).values({
    id: "deployment",
    projectId: "project",
    organizationId: "org",
    branch: "main",
    status: "ready",
  });
});
beforeEach(async () => {
  vi.clearAllMocks();
  h.revoked = false;
  h.installed.clear();
  await db.delete(schema.domain);
  await db.delete(schema.acmeAccount);
  await db
    .update(schema.project)
    .set({ activeDeploymentId: "deployment", disabledAt: null, deletionInProgress: false })
    .where(eq(schema.project.id, "project"));
  await db
    .update(schema.deployment)
    .set({ meta: { serverId: "remote", deployTarget: "server" } })
    .where(eq(schema.deployment.id, "deployment"));
  await db.insert(schema.domain).values({
    id: "domain",
    projectId: "project",
    hostname,
    domainType: "custom",
    sslChallenge: "dns-01",
  });
  h.txt.mockReset().mockResolvedValue([["exact-", "TXT-value"], ["another-validation"]]);
  h.prepare.mockReset().mockResolvedValue({
    record: { name: "_acme-challenge.example.com", value: "exact-TXT-value" },
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    state: "private-saved-order-and-key",
  });
  h.complete.mockReset().mockResolvedValue(certificate);
  h.activate.mockReset().mockResolvedValue(undefined);
  h.install
    .mockReset()
    .mockImplementation(async (server: string, _host: string, _pair: ManualCert) => {
      const result = valid();
      h.installed.set(server, result);
      return result;
    });
  h.provision.mockReset().mockImplementation(async (server: string) => {
    const result = valid();
    h.installed.set(server, result);
    return result;
  });
  h.resolve.mockReset().mockImplementation(async (meta: { serverId: string }) => {
    if (!["remote", "new-remote"].includes(meta.serverId))
      throw new Error("Wrong certificate target");
    return {
      platform: {
        ssl: {
          dnsChallengeProvider: async () => provider,
          activateCert: h.activate,
          verifyCert: async () =>
            h.installed.get(meta.serverId) ?? {
              domain: hostname,
              verified: false,
              expiresAt: "",
              issuer: "",
              reason: "missing",
            },
          installCert: (host: string, pair: ManualCert) => h.install(meta.serverId, host, pair),
          provisionCert: (host: string, options: unknown) =>
            h.provision(meta.serverId, host, options),
        },
      },
    };
  });
});
afterEach(async () => {
  await drainBackgroundWork();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  encryption.close();
  await client.close();
});

async function prepare() {
  const initial = await startDnsChallenge(ctx, "domain", { mode: "manual" });
  expect(initial.status).toBe("preparing");
  await drainBackgroundWork();
  const row = (await getDnsChallenge(ctx, "domain"))!;
  expect(row.status).toBe("waiting");
  return row;
}
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("manual wildcard HTTPS lifecycle", () => {
  it("reports a failed edge activation and retries the same certificate without another order", async () => {
    h.provision.mockImplementationOnce(async (server: string) => {
      h.installed.set(server, valid());
      throw new Error("Edge reload failed after certificate issuance");
    });
    h.activate.mockRejectedValue(new Error("Edge reload failed"));
    await startDnsChallenge(ctx, "domain", { mode: "automatic" });
    await drainBackgroundWork();
    expect(await getDnsChallenge(ctx, "domain")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Edge reload failed"),
    });
    expect(await h.repos.domain.findById("domain")).toMatchObject({ verified: false });

    h.activate.mockResolvedValue(undefined);
    await startDnsChallenge(ctx, "domain", { mode: "automatic" });
    await drainBackgroundWork();
    expect(await getDnsChallenge(ctx, "domain")).toMatchObject({ status: "completed" });
    expect(await h.repos.domain.findById("domain")).toMatchObject({
      verified: true,
      sslStatus: "active",
    });
    expect(h.provision).toHaveBeenCalledOnce();
    expect(h.activate).toHaveBeenCalledWith(hostname);
  });

  it("persists the actual TXT securely, recovers on reopen and installs on the serving target", async () => {
    const pending = await prepare();
    expect(pending.record).toEqual({
      type: "TXT",
      name: "_acme-challenge.example.com",
      value: "exact-TXT-value",
    });
    expect(await getDnsChallenge(ctx, "domain")).toEqual(pending);
    expect(await startDnsChallenge(ctx, "domain", { mode: "manual" })).toEqual(pending);
    expect(h.prepare).toHaveBeenCalledOnce();
    const stored = (await h.repos.domainDnsChallenge.find("domain"))!;
    expect(stored.orderEnc).toMatch(/^enc1:/);
    expect(decryptSecretField(stored.orderEnc)).toBe("private-saved-order-and-key");
    expect(stored.leaseId).toBeNull();
    expect(JSON.stringify(pending)).not.toMatch(/private-|orderEnc|accountId|leaseId/);

    await checkDnsChallenge(ctx, "domain", pending.id);
    await drainBackgroundWork();
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(
      hostname,
      "private-account-key",
      "private-saved-order-and-key",
    );
    expect(h.install).toHaveBeenCalledExactlyOnceWith("remote", hostname, certificate);
    expect(await getDnsChallenge(ctx, "domain")).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(await h.repos.domainDnsChallenge.find("domain")).toMatchObject({
      orderEnc: null,
      leaseId: null,
    });
    expect(await h.repos.domain.findById("domain")).toMatchObject({
      verified: true,
      status: "active",
      sslStatus: "active",
      sslDnsMode: "manual",
      isPrimary: false,
    });
    expect(h.dispose).toHaveBeenCalled();
  });

  it("does not consume an ACME validation before the exact TXT exists; retry reuses the order", async () => {
    const pending = await prepare();
    h.txt.mockResolvedValueOnce([["unrelated-TXT-value"]]);
    await checkDnsChallenge(ctx, "domain", pending.id);
    await drainBackgroundWork();
    expect(await getDnsChallenge(ctx, "domain")).toMatchObject({
      id: pending.id,
      status: "waiting",
      error: expect.stringContaining("not visible"),
    });
    expect(h.complete).not.toHaveBeenCalled();
    await checkDnsChallenge(ctx, "domain", pending.id);
    await drainBackgroundWork();
    expect((await getDnsChallenge(ctx, "domain"))?.status).toBe("completed");
    expect(h.prepare).toHaveBeenCalledOnce();
  });

  it("allows only one worker for simultaneous starts and checks", async () => {
    const starts = await Promise.all([
      startDnsChallenge(ctx, "domain", { mode: "manual" }),
      startDnsChallenge(ctx, "domain", { mode: "automatic" }),
    ]);
    await drainBackgroundWork();
    expect(starts[0].id).toBe(starts[1].id);
    expect(h.prepare).toHaveBeenCalledOnce();
    await Promise.all([
      checkDnsChallenge(ctx, "domain", starts[0].id),
      checkDnsChallenge(ctx, "domain", starts[0].id),
    ]);
    await drainBackgroundWork();
    expect(h.complete).toHaveBeenCalledOnce();
    expect(h.install).toHaveBeenCalledOnce();
  });

  it("cancels an in-flight validation without installing or allowing stale requests into a new attempt", async () => {
    const pending = await prepare();
    const running = gate<ManualCert>();
    h.complete.mockReturnValueOnce(running.promise);
    await checkDnsChallenge(ctx, "domain", pending.id);
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalledOnce());
    expect((await cancelDnsChallenge(ctx, "domain", pending.id)).status).toBe("cancelling");
    running.resolve(certificate);
    await drainBackgroundWork();
    expect(h.install).not.toHaveBeenCalled();
    expect((await getDnsChallenge(ctx, "domain"))?.status).toBe("cancelled");
    const next = await prepare();
    expect(next.id).not.toBe(pending.id);
    await expect(checkDnsChallenge(ctx, "domain", pending.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(cancelDnsChallenge(ctx, "domain", pending.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("cannot cancel after installation starts", async () => {
    const pending = await prepare();
    const installing = gate<SslResult>();
    h.install.mockReturnValueOnce(installing.promise);
    await checkDnsChallenge(ctx, "domain", pending.id);
    await vi.waitFor(() => expect(h.install).toHaveBeenCalledOnce());
    await expect(cancelDnsChallenge(ctx, "domain", pending.id)).rejects.toThrow(/being installed/);
    installing.resolve(valid());
    await drainBackgroundWork();
    expect((await getDnsChallenge(ctx, "domain"))?.status).toBe("completed");
  });

  it("does not let an expired installation worker overwrite a resumed attempt's state", async () => {
    const pending = await prepare();
    const installing = gate<SslResult>();
    h.install.mockReturnValueOnce(installing.promise);
    await checkDnsChallenge(ctx, "domain", pending.id);
    await vi.waitFor(() => expect(h.install).toHaveBeenCalledOnce());
    await db.update(schema.domainDnsChallenge).set({ leaseExpiresAt: new Date(Date.now() - 1000) });
    expect(await getDnsChallenge(ctx, "domain")).toMatchObject({
      id: pending.id,
      status: "waiting",
    });
    installing.resolve(valid());
    await drainBackgroundWork();
    expect(await getDnsChallenge(ctx, "domain")).toMatchObject({
      id: pending.id,
      status: "waiting",
    });
    expect(await h.repos.domain.findById("domain")).toMatchObject({ verified: false });
    await checkDnsChallenge(ctx, "domain", pending.id);
    await drainBackgroundWork();
    expect(await getDnsChallenge(ctx, "domain")).toMatchObject({ status: "completed" });
    expect(h.prepare).toHaveBeenCalledOnce();
  });

  it("retains healthy TLS and saved issuance on installation failure, then retries the same certificate", async () => {
    const pending = await prepare();
    const old = valid();
    h.installed.set("remote", old);
    await db
      .update(schema.domain)
      .set({ verified: true, sslStatus: "active", sslExpiresAt: new Date(old.expiresAt) })
      .where(eq(schema.domain.id, "domain"));
    h.install.mockRejectedValueOnce(new Error("The edge reload failed"));
    await checkDnsChallenge(ctx, "domain", pending.id);
    await drainBackgroundWork();
    expect(await getDnsChallenge(ctx, "domain")).toMatchObject({
      status: "waiting",
      error: "The edge reload failed",
    });
    expect(await h.repos.domain.findById("domain")).toMatchObject({
      verified: true,
      sslStatus: "active",
      sslExpiresAt: new Date(old.expiresAt),
    });
    expect((await h.repos.domainDnsChallenge.find("domain"))?.orderEnc).toMatch(/^enc1:/);
    await checkDnsChallenge(ctx, "domain", pending.id);
    await drainBackgroundWork();
    expect((await getDnsChallenge(ctx, "domain"))?.status).toBe("completed");
    expect(h.prepare).toHaveBeenCalledOnce();
    expect(h.complete.mock.calls[0]).toEqual(h.complete.mock.calls[1]);
  });

  it("installs on the current server when the project moves while waiting for DNS", async () => {
    const pending = await prepare();
    await db
      .update(schema.deployment)
      .set({ meta: { serverId: "new-remote", deployTarget: "server" } })
      .where(eq(schema.deployment.id, "deployment"));
    await checkDnsChallenge(ctx, "domain", pending.id);
    await drainBackgroundWork();
    expect(h.install).toHaveBeenCalledExactlyOnceWith("new-remote", hostname, certificate);
  });

  it("rechecks permissions before installing after a long CA request", async () => {
    const pending = await prepare();
    const running = gate<ManualCert>();
    h.complete.mockReturnValueOnce(running.promise);
    await checkDnsChallenge(ctx, "domain", pending.id);
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalledOnce());
    h.revoked = true;
    running.resolve(certificate);
    await drainBackgroundWork();
    expect(h.install).not.toHaveBeenCalled();
    expect((await h.repos.domainDnsChallenge.find("domain"))?.status).toBe("waiting");
  });

  it("keeps pending challenges and account material private to the owning organization", async () => {
    await prepare();
    const other = { ...ctx, organizationId: "other" };
    await expect(getDnsChallenge(other, "domain")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(startDnsChallenge(other, "domain", { mode: "manual" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const stored = (await h.repos.domainDnsChallenge.find("domain"))!;
    expect(
      await h.repos.domainDnsChallenge.accountById("other", stored.accountId!),
    ).toBeUndefined();
  });

  it("does not run local certificate setup against a cloud deployment", async () => {
    await db
      .update(schema.deployment)
      .set({ meta: { deployTarget: "cloud" } })
      .where(eq(schema.deployment.id, "deployment"));
    await expect(startDnsChallenge(ctx, "domain", { mode: "automatic" })).rejects.toThrow(
      /managed by its cloud edge/,
    );
    await expect(startDnsChallenge(ctx, "domain", { mode: "manual" })).rejects.toThrow(
      /managed by its cloud edge/,
    );
    expect(await h.repos.domainDnsChallenge.find("domain")).toBeUndefined();
  });

  it("reuses an existing certificate without opening an order; explicit renewal requests a fresh TXT", async () => {
    h.installed.set("remote", valid());
    await startDnsChallenge(ctx, "domain", { mode: "manual" });
    await drainBackgroundWork();
    expect((await getDnsChallenge(ctx, "domain"))?.status).toBe("completed");
    expect(h.prepare).not.toHaveBeenCalled();
    await startDnsChallenge(ctx, "domain", { mode: "manual", force: true });
    await drainBackgroundWork();
    expect((await getDnsChallenge(ctx, "domain"))?.status).toBe("waiting");
    expect(h.prepare).toHaveBeenCalledOnce();
  });

  it("uses the existing automatic DNS issuance and activation path", async () => {
    await startDnsChallenge(ctx, "domain", { mode: "automatic" });
    await drainBackgroundWork();
    expect(await getDnsChallenge(ctx, "domain")).toMatchObject({
      status: "completed",
      record: null,
    });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.provision).toHaveBeenCalledWith(
      "remote",
      hostname,
      expect.objectContaining({
        challenge: "dns-01",
        dnsAuthHookScript: expect.stringContaining("cloudflare.com"),
      }),
    );
    expect(await h.repos.domain.findById("domain")).toMatchObject({
      verified: true,
      sslStatus: "active",
      sslDnsMode: "automatic",
    });
    expect(JSON.stringify(await getDnsChallenge(ctx, "domain"))).not.toContain("secret-dns-token");
  });

  it("automatic setup checks the serving host instead of trusting stale active metadata", async () => {
    await db
      .update(schema.domain)
      .set({
        verified: true,
        status: "active",
        sslStatus: "active",
        sslExpiresAt: new Date(valid().expiresAt),
      })
      .where(eq(schema.domain.id, "domain"));
    await startDnsChallenge(ctx, "domain", { mode: "automatic" });
    await drainBackgroundWork();
    expect(h.provision).toHaveBeenCalledOnce();
    expect((await getDnsChallenge(ctx, "domain"))?.status).toBe("completed");
  });

  it.each([
    { externalIngress: true },
    { manualSsl: true },
    { domainType: "free" },
    { status: "removing" },
  ])("does not take over externally managed or removed TLS: %j", async (patch) => {
    await db.update(schema.domain).set(patch).where(eq(schema.domain.id, "domain"));
    await expect(startDnsChallenge(ctx, "domain", { mode: "manual" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(await h.repos.domainDnsChallenge.find("domain")).toBeUndefined();
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it("does not install when the project is disabled during validation", async () => {
    const pending = await prepare();
    const running = gate<ManualCert>();
    h.complete.mockReturnValueOnce(running.promise);
    await checkDnsChallenge(ctx, "domain", pending.id);
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalledOnce());
    await db
      .update(schema.project)
      .set({ disabledAt: new Date() })
      .where(eq(schema.project.id, "project"));
    running.resolve(certificate);
    await drainBackgroundWork();
    expect(h.install).not.toHaveBeenCalled();
  });

  it("rechecks native execution policy when the serving target changes during validation", async () => {
    const pending = await prepare();
    const running = gate<ManualCert>();
    h.complete.mockReturnValueOnce(running.promise);
    await checkDnsChallenge(ctx, "domain", pending.id);
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalledOnce());
    vi.stubEnv("OPENSHIP_NATIVE", "true");
    vi.stubEnv("OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION", "false");
    await db
      .update(schema.deployment)
      .set({ meta: { deployTarget: "local" } })
      .where(eq(schema.deployment.id, "deployment"));
    running.resolve(certificate);
    await drainBackgroundWork();
    expect(h.install).not.toHaveBeenCalled();
    expect((await h.repos.domainDnsChallenge.find("domain"))?.error).toMatch(
      /Host execution is disabled/,
    );
  });
});
