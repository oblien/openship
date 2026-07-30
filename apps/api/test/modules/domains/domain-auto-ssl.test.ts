import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const domainRepo = vi.hoisted(() => ({
  findPendingVerification: vi.fn(),
  findPendingSsl: vi.fn(),
  findById: vi.fn(),
}));
const projectRepo = vi.hoisted(() => ({
  findById: vi.fn(),
}));
const ssl = vi.hoisted(() => ({
  manageDomainSsl: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    domain: domainRepo,
    project: projectRepo,
  },
}));

vi.mock("../../../src/lib/domain-ssl", () => ({
  manageDomainSsl: ssl.manageDomainSsl,
  tlsIssuedElsewhere: () => null,
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

vi.mock("../../../src/lib/route-apply.service", () => ({
  reconcileProjectRoutes: vi.fn(),
}));

vi.mock("../../../src/lib/server-target", () => ({
  resolveProjectServerHost: vi.fn(),
}));

vi.mock("../../../src/lib/ssh-manager", () => ({
  sshManager: {
    probeReachable: vi.fn(),
    withExecutor: vi.fn(),
    withHostExecutor: vi.fn(),
  },
}));

import { verifyPendingDomains } from "../../../src/modules/domains/domain.service";

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
});
