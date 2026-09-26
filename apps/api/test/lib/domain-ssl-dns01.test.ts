import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Domain } from "@repo/db";
import type { SslProvider } from "@repo/adapters";

const h = vi.hoisted(() => ({
  domains: new Map<string, Record<string, unknown>>(),
  updateSsl: vi.fn(),
  recordSslFailure: vi.fn(),
  markVerifiedActive: vi.fn(),
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
      recordSslFailure: h.recordSslFailure,
      markVerifiedActive: h.markVerifiedActive,
    },
    project: {
      findById: vi.fn(async (id: string) => ({
        id,
        organizationId: "org_1",
        activeDeploymentId: "dep_1",
      })),
    },
    deployment: {
      findById: vi.fn(async (id: string) => ({ id, projectId: "prj_1", organizationId: "org_1", meta: {} })),
    },
    server: { findLocal: vi.fn(async () => null) },
  },
}));
vi.mock("../../src/lib/controller-helpers", () => ({
  platform: () => ({ target: "selfhosted", runtime: {} }),
}));

vi.mock("@repo/platform/engine/lib/provision-lock", () => ({
  createProvisionLock: () => ({ run: <T>(fn: () => Promise<T>) => fn() }),
}));

vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
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

vi.mock("@repo/platform/engine/modules/dns/dns-credential.service", () => ({
  resolveDnsManager: vi.fn(async () => h.dnsManagerResult),
}));

import {
  manageDomainSsl,
  provisionDomainCertForVerify,
  createDnsHookScripts,
} from "@repo/platform/engine/lib/domain-ssl";
import { createTrackedSslProvider } from "@repo/platform/engine/lib/routing-domains";

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
    h.recordSslFailure.mockClear();
    h.markVerifiedActive.mockClear();
    h.disposePlatform.mockClear();
    h.provisionCert.mockClear();
    h.renewCert.mockClear();
    h.verifyCert.mockReset().mockResolvedValue({
      domain: "app.example.com",
      expiresAt: "",
      issuer: "Let's Encrypt",
      verified: false,
    });
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

  it("reuses a valid wildcard certificate without requiring DNS credentials for a new order", async () => {
    h.dnsManagerResult = { status: "none" } as unknown as typeof h.dnsManagerResult;
    domain("*.example.com", { sslChallenge: "dns-01" });
    h.verifyCert.mockResolvedValueOnce({
      domain: "*.example.com",
      expiresAt: "2030-01-01T00:00:00.000Z",
      issuer: "Let's Encrypt",
      verified: true,
    });
    const result = await manageDomainSsl("*.example.com", { action: "provision" });
    expect(result).toMatchObject({ verified: true, expiresAt: "2030-01-01T00:00:00.000Z" });
    expect(h.provisionCert).not.toHaveBeenCalled();
    expect(h.updateSsl).toHaveBeenCalledWith(
      "dom_*.example.com",
      expect.objectContaining({ sslStatus: "active" }),
    );
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

  it("does not issue or renew a manual TXT certificate through the connected provider", async () => {
    domain("*.example.com", { sslChallenge: "dns-01", sslDnsMode: "manual" });
    await expect(manageDomainSsl("*.example.com", { action: "provision" })).rejects.toThrow(/manual TXT/);
    await expect(manageDomainSsl("*.example.com", { action: "renew" })).rejects.toThrow(/manual TXT/);
    expect(h.provisionCert).not.toHaveBeenCalled();
    expect(h.renewCert).not.toHaveBeenCalled();
  });

  it("reuses an existing manual TXT certificate without touching its provider", async () => {
    domain("*.example.com", { sslChallenge: "dns-01", sslDnsMode: "manual" });
    h.verifyCert.mockResolvedValue({ domain: "*.example.com", expiresAt: "2030-01-01T00:00:00.000Z", issuer: "Let's Encrypt", verified: true });
    expect(await manageDomainSsl("*.example.com", { action: "provision" })).toMatchObject({ verified: true });
    expect(h.provisionCert).not.toHaveBeenCalled();
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
      /connected DNS provider.*Settings → DNS.*Manual TXT/,
    );
    expect(h.provisionCert).not.toHaveBeenCalled();
    expect(h.recordSslFailure).toHaveBeenCalledWith(
      "dom_*.example.com",
      expect.stringMatching(/connected DNS provider.*Manual TXT/),
    );
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
    expect(h.recordSslFailure).toHaveBeenCalledWith(
      "dom_app.example.com",
      expect.stringContaining("DNS provider credential rejected: Invalid token"),
    );
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

  it("issues a first wildcard deployment on its selected server with the shared DNS hooks", async () => {
    const host = "*.example.com";
    domain(host, { verified: false, sslChallenge: "dns-01" });
    const selected: SslProvider = {
      provisionCert: vi.fn(async () => ({ domain: host, verified: true, expiresAt: "2030-01-01T00:00:00.000Z", issuer: "Let's Encrypt" })),
      verifyCert: vi.fn(async () => ({ domain: host, verified: false, expiresAt: "", issuer: "", reason: "missing" })),
      renewCert: vi.fn(), installCert: vi.fn(),
    };
    const rows = new Map([[host, h.domains.get(host) as unknown as Domain]]);
    const tracked = createTrackedSslProvider(selected, rows, undefined, "new-server");

    expect(await tracked.provisionCert(host)).toMatchObject({ verified: true });
    expect(selected.provisionCert).toHaveBeenCalledExactlyOnceWith(host, expect.objectContaining({
      challenge: "dns-01", dnsAuthHookScript: expect.stringContaining("zone_123"),
      dnsCleanupHookScript: expect.stringContaining("DELETE"),
    }));
    expect(h.provisionCert).not.toHaveBeenCalled(); // The previous serving target is never used.
    expect(h.markVerifiedActive).toHaveBeenCalledWith(`dom_${host}`, expect.objectContaining({ sslStatus: "active" }));
  });

  it.each([false, true])("keeps manual DNS ownership during deployment (certificate present: %s)", async (present) => {
    const host = "*.example.com";
    domain(host, { sslChallenge: "dns-01", sslDnsMode: "manual" });
    const selected: SslProvider = {
      provisionCert: vi.fn(), renewCert: vi.fn(), installCert: vi.fn(),
      verifyCert: vi.fn(async () => ({ domain: host, verified: present, expiresAt: present ? "2030-01-01T00:00:00.000Z" : "", issuer: "Let's Encrypt", reason: present ? undefined : "missing" })),
    };
    const rows = new Map([[host, h.domains.get(host) as unknown as Domain]]);
    const result = await createTrackedSslProvider(selected, rows).provisionCert(host);
    expect(result.verified).toBe(present);
    expect(selected.provisionCert).not.toHaveBeenCalled();
    expect(h.provisionCert).not.toHaveBeenCalled();
    if (present) expect(h.recordSslFailure).not.toHaveBeenCalled();
    else expect(h.recordSslFailure).toHaveBeenCalledWith(`dom_${host}`, expect.stringContaining("manual TXT"), true);
  });

  it("does not report deployment HTTPS ready when activation fails with a valid certificate on disk", async () => {
    const host = "*.example.com";
    domain(host, { sslChallenge: "dns-01", sslDnsMode: "manual" });
    const selected: SslProvider = {
      provisionCert: vi.fn(), renewCert: vi.fn(), installCert: vi.fn(),
      verifyCert: vi.fn(async () => ({ domain: host, verified: true, expiresAt: "2030-01-01T00:00:00.000Z", issuer: "Let's Encrypt" })),
      activateCert: vi.fn().mockRejectedValue(new Error("Edge reload failed")),
    };
    const rows = new Map([[host, h.domains.get(host) as unknown as Domain]]);
    const result = await createTrackedSslProvider(selected, rows).provisionCert(host);
    expect(result.verified).toBe(false);
    expect(selected.provisionCert).not.toHaveBeenCalled();
    expect(h.updateSsl).not.toHaveBeenCalled();
    expect(h.recordSslFailure).toHaveBeenCalledWith(`dom_${host}`, "Edge reload failed");
  });
});

// The application seams moved with the shared engine.
vi.mock("@repo/platform/engine/lib/platform-config", () => ({
  platform: () => ({ target: "selfhosted", runtime: {} }),
}));

vi.mock("@repo/platform/engine/lib/resource-access", () => ({
  platform: () => ({ target: "selfhosted", runtime: {} }),
}));
