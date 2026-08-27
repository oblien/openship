import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  domains: new Map<string, Record<string, unknown>>(),
  updateSsl: vi.fn(),
  disposePlatform: vi.fn(),
  provisionCert: vi.fn(async (domain: string, _opts?: unknown) => ({
    domain,
    expiresAt: "2030-01-01T00:00:00.000Z",
    issuer: "Let's Encrypt",
    verified: true,
    reason: "issued" as const,
  })),
  renewCert: vi.fn(async (domain: string, _opts?: unknown) => ({
    domain,
    expiresAt: "2030-01-01T00:00:00.000Z",
    issuer: "Let's Encrypt",
    verified: true,
    reason: "renewed" as const,
  })),
  verifyCert: vi.fn(async (domain: string) => ({
    domain,
    expiresAt: "2030-01-01T00:00:00.000Z",
    issuer: "Let's Encrypt",
    verified: true,
  })),
  dnsManagerResult: {
    status: "matched" as const,
    manager: {
      credentialId: "cred_1",
      provider: {
        name: "cloudflare" as const,
        descriptor: { name: "cloudflare" as const, displayName: "Cloudflare", description: "" },
      },
      zone: { id: "zone_123", name: "example.com", status: "active" },
      credentials: { apiToken: "test-token" },
    },
  },
}));

vi.mock("@repo/db", () => ({
  repos: {
    domain: {
      findByHostname: vi.fn(async (hostname: string) => h.domains.get(hostname) ?? null),
      updateSsl: h.updateSsl,
    },
    project: {
      findById: vi.fn(async (id: string) => ({
        id,
        organizationId: "org_1",
        activeDeploymentId: "dep_1",
      })),
    },
    deployment: {
      findById: vi.fn(async (id: string) => ({ id, organizationId: "org_1", meta: {} })),
    },
    server: { findLocal: vi.fn(async () => null) },
  },
}));
vi.mock("../../src/lib/controller-helpers", () => ({
  platform: () => ({ target: "selfhosted", runtime: {} }),
}));

vi.mock("../../src/lib/provision-lock", () => ({
  createProvisionLock: () => ({ run: <T>(fn: () => Promise<T>) => fn() }),
}));

vi.mock("../../src/lib/deployment-runtime", () => ({
  disposePlatform: h.disposePlatform,
  resolveDeploymentPlatform: vi.fn(async () => ({
    platform: {
      ssl: {
        provisionCert: h.provisionCert,
        renewCert: h.renewCert,
        verifyCert: h.verifyCert,
      },
    },
  })),
}));

vi.mock("../../src/modules/dns/dns-credential.service", () => ({
  resolveDnsManager: vi.fn(async () => h.dnsManagerResult),
}));

import {
  manageDomainSsl,
  provisionDomainCertForVerify,
  createDnsHookScripts,
} from "../../src/lib/domain-ssl";

function domain(hostname: string, extra: Record<string, unknown> = {}) {
  h.domains.set(hostname, {
    id: `dom_${hostname}`,
    hostname,
    projectId: "prj_1",
    organizationId: "org_1",
    verified: true,
    status: "active",
    sslStatus: "none",
    sslChallenge: "http-01",
    ...extra,
  });
}

describe("DNS-01 ACME challenge support in domain-ssl", () => {
  beforeEach(() => {
    h.domains.clear();
    h.updateSsl.mockClear();
    h.disposePlatform.mockClear();
    h.provisionCert.mockClear();
    h.renewCert.mockClear();
    h.verifyCert.mockClear();
    h.dnsManagerResult = {
      status: "matched",
      manager: {
        credentialId: "cred_1",
        provider: {
          name: "cloudflare",
          descriptor: { name: "cloudflare", displayName: "Cloudflare", description: "" },
        },
        zone: { id: "zone_123", name: "example.com", status: "active" },
        credentials: { apiToken: "test-token" },
      },
    };
  });

  it("passes challenge: 'dns-01' and generated hooks to provisionCert when sslChallenge is dns-01", async () => {
    domain("app.example.com", { sslChallenge: "dns-01" });

    const result = await manageDomainSsl("app.example.com", { action: "provision" });

    expect(result.verified).toBe(true);
    expect(h.provisionCert).toHaveBeenCalledTimes(1);
    const [calledHost, calledOpts] = h.provisionCert.mock.calls[0] as [
      string,
      { challenge?: string; dnsAuthHookScript?: string; dnsCleanupHookScript?: string },
    ];
    expect(calledHost).toBe("app.example.com");
    expect(calledOpts.challenge).toBe("dns-01");
    expect(calledOpts.dnsAuthHookScript).toContain("cloudflare.com/client/v4");
    expect(calledOpts.dnsCleanupHookScript).toContain("DELETE");
  });

  it("automatically uses DNS-01 challenge for wildcard domains", async () => {
    domain("*.example.com", { sslChallenge: "http-01" }); // Even if marked http-01, wildcard enforces dns-01

    const result = await manageDomainSsl("*.example.com", { action: "provision" });

    expect(result.verified).toBe(true);
    expect(h.provisionCert).toHaveBeenCalledTimes(1);
    const [, calledOpts] = h.provisionCert.mock.calls[0] as [
      string,
      { challenge?: string; dnsAuthHookScript?: string },
    ];
    expect(calledOpts.challenge).toBe("dns-01");
    expect(calledOpts.dnsAuthHookScript).toBeDefined();
  });

  it("provisionDomainCertForVerify generates DNS hooks and passes dns-01 for unverified wildcard domain", async () => {
    domain("*.example.com", { verified: false, sslChallenge: "dns-01" });

    const result = await provisionDomainCertForVerify("*.example.com", { force: true });

    expect(result.verified).toBe(true);
    expect(h.provisionCert).toHaveBeenCalledTimes(1);
    const [, calledOpts] = h.provisionCert.mock.calls[0] as [
      string,
      { challenge?: string; dnsAuthHookScript?: string },
    ];
    expect(calledOpts.challenge).toBe("dns-01");
    expect(calledOpts.dnsAuthHookScript).toBeDefined();
  });

  it("fails with an actionable message when DNS-01 is needed but no DNS provider is connected", async () => {
    h.dnsManagerResult = { status: "none" } as unknown as typeof h.dnsManagerResult;
    domain("*.example.com", { sslChallenge: "dns-01" });

    await expect(manageDomainSsl("*.example.com", { action: "provision" })).rejects.toThrow(
      /requires a connected DNS provider.*Settings → DNS/,
    );
    expect(h.provisionCert).not.toHaveBeenCalled();
  });

  it("fails when DNS provider credential was rejected", async () => {
    h.dnsManagerResult = {
      status: "unauthorized",
      credentialId: "cred_1",
      reason: "Invalid token",
    } as unknown as typeof h.dnsManagerResult;
    domain("app.example.com", { sslChallenge: "dns-01" });

    await expect(manageDomainSsl("app.example.com", { action: "provision" })).rejects.toThrow(
      /DNS provider credential rejected: Invalid token/,
    );
    expect(h.provisionCert).not.toHaveBeenCalled();
  });

  it("uses caller-supplied dnsAuthHook and dnsCleanupHook without querying provider", async () => {
    domain("app.example.com", { sslChallenge: "dns-01" });

    await manageDomainSsl("app.example.com", {
      action: "provision",
      dnsAuthHook: "/custom/auth.sh",
      dnsCleanupHook: "/custom/cleanup.sh",
    });

    expect(h.provisionCert).toHaveBeenCalledTimes(1);
    const [, calledOpts] = h.provisionCert.mock.calls[0] as [
      string,
      { challenge?: string; dnsAuthHook?: string; dnsCleanupHook?: string },
    ];
    expect(calledOpts.challenge).toBe("dns-01");
    expect(calledOpts.dnsAuthHook).toBe("/custom/auth.sh");
    expect(calledOpts.dnsCleanupHook).toBe("/custom/cleanup.sh");
  });

  it("builds hooks that validate provider success and wait for public DNS", () => {
    const hooks = createDnsHookScripts({
      credentialId: "cred_1",
      provider: {
        name: "cloudflare",
        descriptor: { name: "cloudflare", displayName: "Cloudflare", description: "" },
      },
      zone: { id: "zone_cf_123", name: "test.com", status: "active" },
      credentials: { apiToken: "secret_cf_token" },
    });

    expect(hooks.authHookScript).toContain("zone_cf_123");
    expect(hooks.authHookScript).toContain("secret_cf_token");
    expect(hooks.authHookScript).toContain('"success":true');
    expect(hooks.authHookScript).toContain("cloudflare-dns.com/dns-query");
    expect(hooks.authHookScript).toContain("OPENSHIP_DNS_RECORD_FILE");
    expect(hooks.cleanupHookScript).toContain("zone_cf_123");
    expect(hooks.cleanupHookScript).toContain("secret_cf_token");
  });

  it("passes fresh generated hooks to DNS-01 renewal", async () => {
    domain("app.example.com", { sslChallenge: "dns-01" });
    await manageDomainSsl("app.example.com", { action: "renew" });
    const [, calledOpts] = h.renewCert.mock.calls[0] as [
      string,
      { challenge?: string; dnsAuthHookScript?: string; dnsCleanupHookScript?: string },
    ];
    expect(calledOpts.challenge).toBe("dns-01");
    expect(calledOpts.dnsAuthHookScript).toContain("cloudflare.com/client/v4");
    expect(calledOpts.dnsCleanupHookScript).toContain("DELETE");
  });
});
