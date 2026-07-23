import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  findDomain,
  findProject,
  listDomains,
  markVerified,
  setPrimary,
  recordVerifyFailure,
  resolveRecords,
  resolveProjectServerHost,
  manageDomainSsl,
} = vi.hoisted(() => ({
  findDomain: vi.fn(),
  findProject: vi.fn(),
  listDomains: vi.fn(),
  markVerified: vi.fn(),
  setPrimary: vi.fn(),
  recordVerifyFailure: vi.fn(),
  resolveRecords: vi.fn(),
  resolveProjectServerHost: vi.fn(),
  manageDomainSsl: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    domain: {
      findById: findDomain,
      listByProject: listDomains,
      markVerified,
      setPrimary,
      recordVerifyFailure,
    },
    project: {
      findById: findProject,
    },
  },
}));

vi.mock("../../../src/lib/controller-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/controller-helpers")>();
  return {
    ...actual,
    platform: () => ({ target: "desktop" }),
  };
});

vi.mock("../../../src/lib/dns-resolver", () => ({
  resolveRecords,
}));

vi.mock("../../../src/lib/server-target", () => ({
  resolveProjectServerHost,
}));

vi.mock("../../../src/lib/domain-ssl", () => ({
  manageDomainSsl,
  installDomainCert: vi.fn(),
}));

vi.mock("../../../src/lib/route-apply.service", () => ({
  reconcileProjectRoutes: vi.fn(),
}));

import { verifyDomain } from "../../../src/modules/domains/domain.service";

const ctx = {
  organizationId: "org-1",
} as any;

const domain = {
  id: "dom-1",
  projectId: "proj-1",
  hostname: "example.com",
  domainType: "custom",
  externalIngress: false,
  verificationToken: "challenge-token",
  verified: false,
  sslStatus: "inactive",
};

const project = {
  id: "proj-1",
  organizationId: "org-1",
  activeDeploymentId: null,
};

describe("verifyDomain", () => {
  beforeEach(() => {
    findDomain.mockReset().mockResolvedValue(domain);
    findProject.mockReset().mockResolvedValue(project);
    listDomains.mockReset().mockResolvedValue([domain]);
    markVerified.mockReset().mockResolvedValue(undefined);
    setPrimary.mockReset().mockResolvedValue(undefined);
    recordVerifyFailure.mockReset().mockResolvedValue(1);
    resolveRecords.mockReset();
    resolveProjectServerHost.mockReset().mockResolvedValue("203.0.113.10");
    manageDomainSsl.mockReset().mockResolvedValue({});
  });

  it("checks the routing and TXT records concurrently", async () => {
    let releaseRouteLookup!: (records: string[]) => void;
    const routeLookup = new Promise<string[]>((resolve) => {
      releaseRouteLookup = resolve;
    });

    resolveRecords.mockImplementation(async (name: string, type: "A" | "TXT") => {
      if (type === "A") return routeLookup;
      if (type === "TXT" && name === "_openship-challenge.example.com") {
        return ["challenge-token"];
      }
      return [];
    });

    const verification = verifyDomain(ctx, domain.id);

    // The A lookup deliberately stays pending. A sequential implementation
    // cannot reach TXT here and reproduces the dashboard's request timeout.
    await vi.waitFor(() => {
      expect(resolveRecords).toHaveBeenCalledWith("_openship-challenge.example.com", "TXT");
    });

    releaseRouteLookup(["203.0.113.10"]);

    await expect(verification).resolves.toEqual(
      expect.objectContaining({
        verified: true,
        recordVerified: true,
        txtVerified: true,
      }),
    );
  });
});
