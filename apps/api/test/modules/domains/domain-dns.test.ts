import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const domainRepo = vi.hoisted(() => ({
  findById: vi.fn(),
}));

const projectRepo = vi.hoisted(() => ({
  findById: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: { domain: domainRepo, project: projectRepo },
}));

vi.mock("../../../src/lib/controller-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/controller-helpers")>();
  return { ...actual, platform: () => ({ target: "local", runtime: {} }) };
});

vi.mock("../../../src/lib/server-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/server-target")>();
  return {
    ...actual,
    resolveProjectServerHost: vi.fn().mockResolvedValue("203.0.113.10"),
    resolveInstancePublicIp: vi.fn().mockResolvedValue(null),
    resolveLocalServerHost: vi.fn().mockResolvedValue(null),
  };
});

// Capture what the domain layer hands the DNS primitives — the mapping (which
// hostname, which records) is the whole contract this file guards. The primitives
// themselves are covered in dns-credential.service.test.ts.
const planRecords = vi.fn().mockResolvedValue({ status: "none", records: [] });
const provisionRecords = vi.fn().mockResolvedValue({ provisioned: true, records: [] });
vi.mock("../../../src/modules/dns/dns-credential.service", () => ({
  planRecords: (...args: unknown[]) => planRecords(...args),
  provisionRecords: (...args: unknown[]) => provisionRecords(...args),
  releaseRecords: vi.fn().mockResolvedValue({ deleted: 0 }),
}));

import { planDomainDns, applyDomainDns } from "../../../src/modules/domains/domain.service";

const ctx = { organizationId: "org_123", userId: "user_123" } as any;

const project = { id: "proj_123", organizationId: "org_123" };

const domain = {
  id: "dom_1",
  projectId: project.id,
  serviceId: null,
  hostname: "example.com",
  verificationToken: "verify-1",
  externalIngress: false,
  isPrimary: true,
  verified: false,
  status: "pending",
  domainType: "custom",
};

describe("domain DNS plan/apply mapping", () => {
  beforeEach(() => {
    domainRepo.findById.mockReset();
    domainRepo.findById.mockResolvedValue(domain);
    projectRepo.findById.mockReset();
    projectRepo.findById.mockResolvedValue(project);
    planRecords.mockClear();
    provisionRecords.mockClear();
  });

  it("plans exactly this domain's own record — the apex A pointing at the box", async () => {
    const out = await planDomainDns(ctx, "dom_1");

    expect(planRecords).toHaveBeenCalledTimes(1);
    const [org, hostname, inputs] = planRecords.mock.calls[0] as [string, string, unknown[]];
    expect(org).toBe("org_123");
    expect(hostname).toBe("example.com");
    // Self-hosted apex: a single A record, no ownership TXT (verification is
    // ACME-driven), and never a sibling's name.
    expect(inputs).toEqual([{ type: "A", name: "example.com", content: "203.0.113.10" }]);
    // Read-only: apply's writer is not touched by a plan.
    expect(provisionRecords).not.toHaveBeenCalled();
    // The primitive's result passes straight through.
    expect(out).toEqual({ status: "none", records: [] });
  });

  it("applies the SAME inputs the plan previewed — one source of truth", async () => {
    await planDomainDns(ctx, "dom_1");
    await applyDomainDns(ctx, "dom_1");

    const planned = (planRecords.mock.calls[0] as unknown[])[2];
    const applied = (provisionRecords.mock.calls[0] as unknown[])[2];
    expect(applied).toEqual(planned);
  });

  it("drops a record whose target is unknown rather than planning an empty write", async () => {
    // No resolvable server IP → buildRecords emits value "" for the A record;
    // desiredDnsInputs must filter it out, leaving nothing to plan.
    const serverTarget = await import("../../../src/lib/server-target");
    (serverTarget.resolveProjectServerHost as any).mockResolvedValueOnce(null);
    (serverTarget.resolveInstancePublicIp as any).mockResolvedValueOnce(null);

    await planDomainDns(ctx, "dom_1");

    const inputs = (planRecords.mock.calls[0] as unknown[])[2];
    expect(inputs).toEqual([]);
  });
});
