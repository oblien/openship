import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@repo/core";

const domainRepo = vi.hoisted(() => ({
  create: vi.fn(),
  findByHostname: vi.fn(),
  setPrimary: vi.fn(),
  update: vi.fn(),
}));

const projectRepo = vi.hoisted(() => ({
  findById: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    domain: domainRepo,
    project: projectRepo,
  },
}));

vi.mock("../../../src/lib/controller-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/controller-helpers")>();
  return {
    ...actual,
    platform: () => ({ target: "local", runtime: {} }),
  };
});

vi.mock("../../../src/lib/server-target", () => ({
  resolveProjectServerHost: vi.fn().mockResolvedValue("203.0.113.10"),
}));

vi.mock("../../../src/lib/domain-ssl", () => ({
  installDomainCert: vi.fn(),
  manageDomainSsl: vi.fn(),
}));

vi.mock("../../../src/lib/dns-resolver", () => ({
  resolveRecords: vi.fn(),
}));

vi.mock("../../../src/lib/route-apply.service", () => ({
  reconcileProjectRoutes: vi.fn(),
}));

import { addDomain } from "../../../src/modules/domains/domain.service";

const project = {
  id: "proj_123",
  organizationId: "org_123",
};

const context = {
  organizationId: "org_123",
  userId: "user_123",
};

const existingDomain = {
  id: "dom_existing",
  projectId: project.id,
  serviceId: null,
  hostname: "example.com",
  verificationToken: "verify-existing",
  externalIngress: false,
  isPrimary: false,
  verified: false,
  status: "pending",
};

describe("addDomain retries", () => {
  beforeEach(() => {
    domainRepo.create.mockReset();
    domainRepo.findByHostname.mockReset();
    domainRepo.setPrimary.mockReset();
    domainRepo.update.mockReset();
    projectRepo.findById.mockReset();
    projectRepo.findById.mockResolvedValue(project);
  });

  it("reuses a pending domain owned by the same project", async () => {
    domainRepo.findByHostname.mockResolvedValue(existingDomain);

    const result = await addDomain(context as any, {
      projectId: project.id,
      hostname: "example.com",
      isPrimary: true,
    });

    expect(domainRepo.create).not.toHaveBeenCalled();
    expect(domainRepo.setPrimary).toHaveBeenCalledWith(project.id, existingDomain.id);
    expect(result.domain).toMatchObject({
      id: existingDomain.id,
      hostname: existingDomain.hostname,
      isPrimary: true,
    });
    expect(result.records).toEqual({
      mode: "selfhosted",
      records: [
        {
          type: "A",
          host: "@",
          name: "example.com",
          value: "203.0.113.10",
        },
        {
          type: "TXT",
          host: "_openship-challenge",
          name: "_openship-challenge.example.com",
          value: "verify-existing",
        },
      ],
    });
  });

  it("still rejects a domain owned by another project", async () => {
    domainRepo.findByHostname.mockResolvedValue({
      ...existingDomain,
      projectId: "proj_other",
    });

    await expect(
      addDomain(context as any, {
        projectId: project.id,
        hostname: "example.com",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(domainRepo.create).not.toHaveBeenCalled();
    expect(domainRepo.update).not.toHaveBeenCalled();
  });
});
