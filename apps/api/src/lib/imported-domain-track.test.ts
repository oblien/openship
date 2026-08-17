import { beforeEach, describe, expect, it, vi } from "vitest";

const domainRepo = vi.hoisted(() => ({
  findByHostname: vi.fn(),
  findOrCreate: vi.fn(),
  updateSsl: vi.fn(),
  listByProject: vi.fn(),
}));
const projectRepo = vi.hoisted(() => ({ listAllForScan: vi.fn() }));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      domain: domainRepo,
      project: projectRepo,
    },
  };
});

vi.mock("../config/env", () => ({
  env: { OPENSHIP_PUBLIC_URL: "https://ops.example.com" },
}));

import { hostnameFromPublicUrl, reservedOperatorDomains, trackImportedDomain } from "./imported-domain-track";

beforeEach(() => {
  domainRepo.findByHostname.mockReset();
  domainRepo.findOrCreate.mockReset();
  domainRepo.updateSsl.mockReset();
  domainRepo.listByProject.mockReset();
  projectRepo.listAllForScan.mockReset();
});

describe("hostnameFromPublicUrl", () => {
  it("extracts the host", () => {
    expect(hostnameFromPublicUrl("https://Ops.Example.com/")).toBe("ops.example.com");
    expect(hostnameFromPublicUrl("not a url")).toBeNull();
  });
});

describe("reservedOperatorDomains", () => {
  it("includes the public URL host and self-app domain rows", async () => {
    projectRepo.listAllForScan.mockResolvedValue([
      { id: "proj_self", appTemplateId: "openship" },
      { id: "proj_other", appTemplateId: null },
    ]);
    domainRepo.listByProject.mockImplementation(async (id: string) =>
      id === "proj_self" ? [{ hostname: "panel.example.com" }] : [],
    );
    const reserved = await reservedOperatorDomains();
    expect(reserved).toEqual(expect.arrayContaining(["ops.example.com", "panel.example.com"]));
    expect(reserved).not.toContain(undefined);
  });
});

describe("trackImportedDomain", () => {
  it("creates a row with ssl expiry so findExpiringSsl can see it", async () => {
    domainRepo.findByHostname.mockResolvedValue(null);
    domainRepo.findOrCreate.mockResolvedValue({
      id: "dom_1",
      hostname: "restored.example.com",
      sslStatus: "active",
    });
    await trackImportedDomain({
      domain: "Restored.example.com",
      ssl: true,
      cert: { expiresAt: "2027-06-01T00:00:00.000Z", issuer: "Let's Encrypt", verified: true },
    });
    expect(domainRepo.findOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "restored.example.com",
        ownerType: "imported",
        projectId: null,
        verified: true,
        status: "active",
        sslStatus: "active",
        manualSsl: false,
        sslExpiresAt: new Date("2027-06-01T00:00:00.000Z"),
      }),
    );
  });

  it("refreshes ssl on an existing row instead of minting a duplicate", async () => {
    domainRepo.findByHostname.mockResolvedValue({ id: "dom_old", hostname: "a.com", sslIssuer: null });
    await trackImportedDomain({
      domain: "a.com",
      ssl: true,
      cert: { expiresAt: "2027-01-01T00:00:00.000Z", issuer: "Let's Encrypt", verified: true },
    });
    expect(domainRepo.findOrCreate).not.toHaveBeenCalled();
    expect(domainRepo.updateSsl).toHaveBeenCalledWith(
      "dom_old",
      expect.objectContaining({ sslStatus: "active", sslExpiresAt: new Date("2027-01-01T00:00:00.000Z") }),
    );
  });

  it("marks a carried cert as manualSsl so ssl:renew does not hand it to certbot", async () => {
    domainRepo.findByHostname.mockResolvedValue(null);
    domainRepo.findOrCreate.mockResolvedValue({ id: "dom_2", hostname: "a.com", sslStatus: "active" });
    await trackImportedDomain({
      domain: "a.com",
      ssl: true,
      carried: true,
      cert: { expiresAt: "2027-01-01T00:00:00.000Z", issuer: "Let's Encrypt", verified: true },
    });
    expect(domainRepo.findOrCreate).toHaveBeenCalledWith(expect.objectContaining({ manualSsl: true }));
  });
});
