import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const domainRepo = vi.hoisted(() => ({
  findPendingVerification: vi.fn(),
  findPendingSsl: vi.fn(),
  findById: vi.fn(),
  listByProject: vi.fn(),
}));
const projectRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  listByOrganization: vi.fn(),
}));
const ssl = vi.hoisted(() => ({
  manageDomainSsl: vi.fn(),
  tlsIssuedElsewhere: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    domain: domainRepo,
    project: projectRepo,
  },
}));

vi.mock("@repo/platform/engine/lib/domain-ssl", () => ({
  manageDomainSsl: ssl.manageDomainSsl,
  tlsIssuedElsewhere: ssl.tlsIssuedElsewhere,
  installDomainCert: vi.fn(),
  provisionDomainCertForVerify: vi.fn(),
  verifyExistingCert: vi.fn(),
}));

vi.mock("../../../src/lib/controller-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/controller-helpers")>();
  return {
    ...actual,
    platform: () => ({ target: "desktop", runtime: {} }),
  };
});

vi.mock("@repo/platform/engine/lib/route-apply.service", () => ({
  reconcileProjectRoutes: vi.fn(),
}));

vi.mock("@repo/platform/engine/lib/server-target", () => ({
  resolveProjectServerHost: vi.fn(),
}));

vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: {
    probeReachable: vi.fn(),
    withExecutor: vi.fn(),
    withHostExecutor: vi.fn(),
  },
}));

import { verifyPendingDomains, renewOrgCerts } from "@repo/platform/engine/modules/domains/domain.service";

describe("automatic SSL completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    domainRepo.findPendingVerification.mockResolvedValue([]);
    projectRepo.findById.mockResolvedValue({
      id: "proj_1",
      organizationId: "org_1",
    });
  });

  it("retries issuance for a verified domain whose first certificate attempt failed", async () => {
    domainRepo.findPendingSsl.mockResolvedValue([
      {
        id: "dom_issue",
        projectId: "proj_1",
        hostname: "app.example.com",
        domainType: "custom",
        verified: true,
        sslStatus: "provisioning",
        externalIngress: false,
        manualSsl: false,
      },
    ]);
    ssl.manageDomainSsl.mockResolvedValue({
      domain: "app.example.com",
      verified: true,
      expiresAt: "2026-10-01T00:00:00.000Z",
      issuer: "Let's Encrypt",
    });
    domainRepo.findById.mockResolvedValue({
      id: "dom_issue",
      sslStatus: "active",
    });

    const result = await verifyPendingDomains();

    expect(ssl.manageDomainSsl).toHaveBeenCalledWith("app.example.com", {
      action: "provision",
      projectId: "proj_1",
    });
    expect(result.sslIssued).toBe(1);
    expect(result.sslRetrying).toBe(0);
  });

  it("backs off a failed automatic issuance instead of requiring a redeploy", async () => {
    domainRepo.findPendingSsl.mockResolvedValue([
      {
        id: "dom_retry",
        projectId: "proj_1",
        hostname: "retry.example.com",
        domainType: "custom",
        verified: true,
        sslStatus: "provisioning",
        externalIngress: false,
        manualSsl: false,
      },
    ]);
    ssl.manageDomainSsl.mockRejectedValue(new Error("ACME temporarily unavailable"));

    const result = await verifyPendingDomains();

    expect(result.sslIssued).toBe(0);
    expect(result.sslRetrying).toBe(1);
  });

  it("keeps both sweep phases inside the caller's organization", async () => {
    const foreign = {
      id: "dom_foreign",
      projectId: "proj_foreign",
      hostname: "other-tenant.example.com",
    };
    domainRepo.findPendingVerification.mockResolvedValue([foreign]);
    domainRepo.findPendingSsl.mockResolvedValue([foreign]);
    projectRepo.findById.mockResolvedValue({ id: "proj_foreign", organizationId: "org_2" });

    const result = await verifyPendingDomains({ organizationId: "org_1", limit: 12 });

    expect(domainRepo.findPendingVerification).toHaveBeenCalledWith(expect.any(Date), 12, "org_1");
    expect(domainRepo.findPendingSsl).toHaveBeenCalledWith(12, "org_1");
    expect(ssl.manageDomainSsl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ total: 0, details: [], sslIssued: 0, sslRetrying: 0 });
  });

  it("rechecks caller access before issuing TLS for an already verified domain", async () => {
    domainRepo.findPendingSsl.mockResolvedValue([{
      id: "dom_revoked",
      projectId: "proj_1",
      hostname: "revoked.example.com",
    }]);
    const contextFor = vi.fn().mockResolvedValue(null);

    await verifyPendingDomains({ organizationId: "org_1" }, contextFor);

    expect(contextFor).toHaveBeenCalledWith("dom_revoked", "provision");
    expect(ssl.manageDomainSsl).not.toHaveBeenCalled();
  });
});

// The application seams moved with the shared engine.
vi.mock("@repo/platform/engine/lib/platform-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/controller-helpers")>();
  return {
    ...actual,
    platform: () => ({ target: "desktop", runtime: {} }),
  };
});

vi.mock("@repo/platform/engine/lib/resource-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/controller-helpers")>();
  return {
    ...actual,
    platform: () => ({ target: "desktop", runtime: {} }),
  };
});

describe("bulk SSL renewal after a transient failure (#196)", () => {
  const ctx = { userId: "user_1", organizationId: "org_1" } as any;
  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);
  const row = (id: string, sslStatus = "error", days = 5) => ({
    id, projectId: "proj_1", hostname: `${id}.example.com`, sslStatus, sslExpiresAt: inDays(days),
  });
  beforeEach(() => {
    vi.clearAllMocks();
    projectRepo.listByOrganization.mockResolvedValue({ rows: [{ id: "proj_1", organizationId: "org_1" }], total: 1 });
    projectRepo.findById.mockResolvedValue({ id: "proj_1", organizationId: "org_1" });
    ssl.tlsIssuedElsewhere.mockReturnValue(null);
    ssl.manageDomainSsl.mockResolvedValue({ verified: true, expiresAt: inDays(90).toISOString() });
    domainRepo.findById.mockImplementation(async (id: string) => row(id));
  });

  it("retries due errors while respecting certificate ownership and per-domain access", async () => {
    domainRepo.listByProject.mockResolvedValue([
      row("active", "active"), row("retry"), row("fresh", "error", 60),
      { ...row("unissued"), sslExpiresAt: null }, row("external", "external"),
      row("manual", "active"), row("denied"),
    ]);
    ssl.tlsIssuedElsewhere.mockImplementation((domain) => domain.id === "manual" ? "manual" : null);
    const result = await renewOrgCerts(ctx, async (id) => id === "denied" ? null : ctx);

    expect(ssl.manageDomainSsl.mock.calls.map(([host]) => host)).toEqual(["active.example.com", "retry.example.com"]);
    expect(result).toMatchObject({ renewed: 2, results: [{ status: "renewed" }, { status: "renewed" }] });
  });

  it("reports an unverified provider result as failed instead of renewed", async () => {
    domainRepo.listByProject.mockResolvedValue([row("active", "active")]);
    ssl.manageDomainSsl.mockResolvedValue({ verified: false, reason: "missing" });

    const result = await renewOrgCerts(ctx);

    expect(result).toMatchObject({ renewed: 0, results: [{ domain: "active.example.com", status: "failed" }] });
  });
});
