import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `mail.<base>` certificate must be renewable.
 *
 * It is issued through `platform.ssl` like every other cert, but a mail server has
 * no project — and `renewExpiringCerts` reads the `domain` table, while
 * `resolveAuthorizedDomain` used to reject any row whose `projectId` didn't resolve
 * to a project. Net effect: the mail cert worked, was invisible to the renewer, and
 * expired ~90 days after install with nothing to renew it. (On a bare box the
 * distro's certbot package shipped a timer that covered it by accident; a
 * containerized edge has no timer and no host certbot.)
 *
 * These tests pin both halves: the row gets recorded, and a mail-owned row resolves
 * its provider from the mail SERVER rather than a project — without loosening the
 * authorization gate for anything else.
 */
const h = vi.hoisted(() => ({
  domains: new Map<string, Record<string, unknown>>(),
  mailServers: new Map<string, { serverId: string; domain: string }>(),
  servers: new Map<string, { id: string; organizationId: string }>(),
  created: [] as Record<string, unknown>[],
  updateSsl: vi.fn(),
  renewCert: vi.fn(async (domain: string) => ({
    domain,
    expiresAt: "2030-01-01T00:00:00.000Z",
    issuer: "R11",
    verified: true,
    reason: "renewed" as const,
  })),
  verifyCert: vi.fn(),
  resolveDeploymentPlatform: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    domain: {
      findByHostname: vi.fn(async (hostname: string) => h.domains.get(hostname) ?? null),
      findOrCreate: vi.fn(async (data: Record<string, unknown>) => {
        const hostname = String(data.hostname).toLowerCase();
        const existing = h.domains.get(hostname);
        if (existing) return existing;
        const row = { id: `dom_${hostname}`, sslStatus: null, ...data, hostname };
        h.domains.set(hostname, row);
        h.created.push(row);
        return row;
      }),
      updateSsl: h.updateSsl,
    },
    project: { findById: vi.fn(async () => null) },
    deployment: { findById: vi.fn(async () => null) },
    mailServer: {
      findByDomain: vi.fn(async (d: string) => h.mailServers.get(d)),
    },
    server: {
      get: vi.fn(async (id: string) => h.servers.get(id)),
      findLocal: vi.fn(async () => undefined),
    },
  },
}));

vi.mock("../../src/lib/deployment-runtime", () => ({
  resolveDeploymentPlatform: h.resolveDeploymentPlatform,
}));

vi.mock("../../src/lib/controller-helpers", () => ({
  platform: () => ({ target: "selfhosted", runtime: {} }),
}));

vi.mock("../../src/lib/provision-lock", () => ({
  createProvisionLock: () => ({ run: <T,>(fn: () => Promise<T>) => fn() }),
}));

vi.mock("../../src/config/env", () => ({
  env: { CLOUD_MODE: false, DEPLOY_MODE: "selfhosted" },
}));

import {
  MAIL_DOMAIN_OWNER,
  manageDomainSsl,
  recordMailCertDomain,
} from "../../src/lib/domain-ssl";

const HOST = "mail.example.com";
const BASE = "example.com";
const ISSUED = {
  domain: HOST,
  expiresAt: "2030-01-01T00:00:00.000Z",
  issuer: "R11",
  verified: true,
  reason: "issued" as const,
};

/** A mail server install: the mail_servers row + the servers row behind it. */
function mailServer() {
  h.mailServers.set(BASE, { serverId: "srv_mail", domain: BASE });
  h.servers.set("srv_mail", { id: "srv_mail", organizationId: "org_1" });
}

/** An already-recorded mail-owned domain row, as step 12 would leave it. */
function mailDomainRow(over: Record<string, unknown> = {}) {
  const row = {
    id: "dom_mail",
    hostname: HOST,
    ownerType: MAIL_DOMAIN_OWNER,
    projectId: null,
    domainType: "custom",
    status: "active",
    verified: true,
    sslStatus: "active",
    externalIngress: false,
    manualSsl: false,
    ...over,
  };
  h.domains.set(HOST, row);
  return row;
}

beforeEach(() => {
  h.domains.clear();
  h.mailServers.clear();
  h.servers.clear();
  h.created.length = 0;
  vi.clearAllMocks();
  h.resolveDeploymentPlatform.mockResolvedValue({
    platform: { ssl: { renewCert: h.renewCert, verifyCert: h.verifyCert } },
  } as never);
});

describe("recordMailCertDomain — put the mail cert on the renewer's list", () => {
  it("creates a mail-owned row with the expiry the renewer keys off", async () => {
    await recordMailCertDomain(HOST, ISSUED);

    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      hostname: HOST,
      ownerType: MAIL_DOMAIN_OWNER,
      verified: true,
    });
    // findExpiringSsl matches on sslStatus=active AND sslExpiresAt — both required.
    expect(h.updateSsl).toHaveBeenCalledWith("dom_mail.example.com", {
      sslStatus: "active",
      sslIssuer: "R11",
      sslExpiresAt: new Date(ISSUED.expiresAt),
    });
  });

  it("is idempotent — a re-run refreshes the expiry instead of duplicating", async () => {
    mailDomainRow();

    await recordMailCertDomain(HOST, ISSUED);

    expect(h.created).toHaveLength(0);
    expect(h.updateSsl).toHaveBeenCalledWith("dom_mail", expect.objectContaining({
      sslStatus: "active",
    }));
  });

  it("refuses to stamp the mail cert onto someone else's domain row", async () => {
    // Same hostname already owned by a project — that owner's SSL lifecycle drives
    // it, and mis-attributing the row would hand mail's expiry to their domain.
    mailDomainRow({ ownerType: "project", projectId: "proj_1", id: "dom_theirs" });

    await recordMailCertDomain(HOST, ISSUED);

    expect(h.updateSsl).not.toHaveBeenCalled();
  });

  it("never throws — bookkeeping must not fail a step whose cert already landed", async () => {
    h.updateSsl.mockRejectedValueOnce(new Error("db is down"));

    await expect(recordMailCertDomain(HOST, ISSUED)).resolves.toBeUndefined();
  });
});

describe("renewing a mail-owned row", () => {
  it("resolves the provider from the mail SERVER, not a project", async () => {
    mailServer();
    mailDomainRow();

    const result = await manageDomainSsl(HOST, { action: "renew" });

    expect(result.verified).toBe(true);
    expect(h.renewCert).toHaveBeenCalledWith(HOST);
    // The whole point: reached the box by serverId, with no project in sight.
    expect(h.resolveDeploymentPlatform).toHaveBeenCalledWith(
      { serverId: "srv_mail" },
      { organizationId: "org_1" },
    );
  });

  it("persists the new expiry so the next sweep sees a fresh cert", async () => {
    mailServer();
    mailDomainRow();

    await manageDomainSsl(HOST, { action: "renew" });

    expect(h.updateSsl).toHaveBeenCalledWith("dom_mail", {
      sslStatus: "active",
      sslIssuer: "R11",
      sslExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
  });

  it("refuses when no mail server owns the hostname", async () => {
    // Row says mail-owned but there's no install behind it (server deleted, or the
    // row predates the mail_servers record) — resolve to nothing rather than
    // falling back to some other box's edge.
    mailDomainRow();

    await expect(manageDomainSsl(HOST, { action: "renew" })).rejects.toThrow();
    expect(h.renewCert).not.toHaveBeenCalled();
  });

  it("refuses a project-scoped caller — a mail row has no project to match", async () => {
    // `projectId` is the defence-in-depth scope. It can never legitimately match a
    // project-less row, so passing one must not widen access to it.
    mailServer();
    mailDomainRow();

    await expect(
      manageDomainSsl(HOST, { action: "renew", projectId: "proj_1" }),
    ).rejects.toThrow();
    expect(h.renewCert).not.toHaveBeenCalled();
  });

  it("still refuses an unverified mail row", async () => {
    mailServer();
    mailDomainRow({ verified: false });

    await expect(manageDomainSsl(HOST, { action: "renew" })).rejects.toThrow(
      /must be verified/i,
    );
  });
});
