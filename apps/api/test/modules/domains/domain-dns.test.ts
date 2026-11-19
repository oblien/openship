import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const domainRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  recordVerifyFailure: vi.fn(),
  listByProject: vi.fn(),
  markVerifiedActive: vi.fn(),
}));

const projectRepo = vi.hoisted(() => ({
  findById: vi.fn(),
}));

const serverTarget = vi.hoisted(() => ({
  resolveProjectServerHost: vi.fn(),
  resolveSelectedServerHost: vi.fn(),
}));

const cloud = vi.hoisted(() => ({
  enabled: false, getClient: vi.fn(), verify: vi.fn(), workspaceForServer: vi.fn(),
  findDeployment: vi.fn(), authorize: vi.fn(), requireAdmin: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/cloud-workspace-scope", () => ({
  workspaceForServer: cloud.workspaceForServer,
  requireCloudWorkspace: vi.fn(async (_org, id) => ({ id })),
}));
vi.mock("@repo/platform/engine/lib/authorization", () => ({
  authorization: { authorize: cloud.authorize },
}));
vi.mock("@repo/platform/engine/lib/organization-authorization", () => ({
  requireOrganizationAdmin: cloud.requireAdmin,
}));
vi.mock("@repo/platform/engine/lib/openship-cloud", () => ({ getNamespaceClient: cloud.getClient }));

vi.mock("@repo/db", () => ({
  repos: { domain: domainRepo, project: projectRepo, deployment: { findById: cloud.findDeployment } },
}));

vi.mock("../../../src/lib/controller-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/controller-helpers")>();
  return { ...actual, platform: () => ({ target: cloud.enabled ? "cloud" : "local", runtime: {} }) };
});

vi.mock("@repo/platform/engine/lib/server-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/platform/engine/lib/server-target")>();
  return {
    ...actual,
    resolveProjectServerHost: serverTarget.resolveProjectServerHost,
    resolveServerHost: serverTarget.resolveSelectedServerHost,
    resolveInstancePublicIp: vi.fn().mockResolvedValue(null),
    resolveLocalServerHost: vi.fn().mockResolvedValue(null),
  };
});

// Capture what the domain layer hands the DNS primitives — the mapping (which
// hostname, which records) is the whole contract this file guards. The primitives
// themselves are covered in dns-credential.service.test.ts.
const planRecords = vi.fn().mockResolvedValue({ status: "none", records: [] });
const provisionRecords = vi.fn().mockResolvedValue({ provisioned: true, records: [] });
vi.mock("@repo/platform/engine/modules/dns/dns-credential.service", () => ({
  planRecords: (...args: unknown[]) => planRecords(...args),
  provisionRecords: (...args: unknown[]) => provisionRecords(...args),
  releaseRecords: vi.fn().mockResolvedValue({ deleted: 0 }),
}));

import {
  applyDomainDns,
  getDomainRecords,
  planDomainDns,
  verifyDomain,
} from "@repo/platform/engine/modules/domains/domain.service";

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
    cloud.enabled = false;
    domainRepo.findById.mockReset();
    domainRepo.findById.mockResolvedValue(domain);
    projectRepo.findById.mockReset();
    projectRepo.findById.mockResolvedValue(project);
    serverTarget.resolveProjectServerHost.mockReset();
    serverTarget.resolveProjectServerHost.mockResolvedValue("203.0.113.10");
    serverTarget.resolveSelectedServerHost.mockReset();
    serverTarget.resolveSelectedServerHost.mockResolvedValue("198.51.100.42");
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

  it("uses the explicit pre-deploy server for records, plan and apply", async () => {
    const records = await getDomainRecords(ctx, "dom_1", "server_new");
    await planDomainDns(ctx, "dom_1", "server_new");
    await applyDomainDns(ctx, "dom_1", "server_new");

    expect(serverTarget.resolveSelectedServerHost).toHaveBeenCalledTimes(3);
    expect(serverTarget.resolveSelectedServerHost).toHaveBeenCalledWith("org_123", "server_new");
    expect(records.records).toEqual([
      { type: "A", host: "@", name: "example.com", value: "198.51.100.42" },
    ]);
    expect((planRecords.mock.calls[0] as unknown[])[2]).toEqual([
      { type: "A", name: "example.com", content: "198.51.100.42" },
    ]);
    expect((provisionRecords.mock.calls[0] as unknown[])[2]).toEqual([
      { type: "A", name: "example.com", content: "198.51.100.42" },
    ]);
  });

  it("drops a record whose target is unknown rather than planning an empty write", async () => {
    // No resolvable server IP → buildRecords emits value "" for the A record;
    // desiredDnsInputs must filter it out, leaving nothing to plan.
    const serverTarget = await import("@repo/platform/engine/lib/server-target");
    (serverTarget.resolveProjectServerHost as any).mockResolvedValueOnce(null);
    (serverTarget.resolveInstancePublicIp as any).mockResolvedValueOnce(null);

    await planDomainDns(ctx, "dom_1");

    const inputs = (planRecords.mock.calls[0] as unknown[])[2];
    expect(inputs).toEqual([]);
  });
});

describe("managed Cloud domain records", () => {
  const parentProof = { host: "_opsh.example.com", value: "verify=workspace-proof" };
  const route = { host: "www.example.com", target: "edge.example.com" };

  beforeEach(() => {
    cloud.enabled = true;
    cloud.getClient.mockReset().mockResolvedValue({ client: { domain: { verify: cloud.verify } } });
    cloud.verify.mockReset();
    cloud.authorize.mockReset().mockResolvedValue(ctx);
    cloud.requireAdmin.mockReset().mockResolvedValue(undefined);
    cloud.workspaceForServer.mockReset();
    cloud.findDeployment.mockReset();
    domainRepo.listByProject.mockResolvedValue([]);
    domainRepo.findById.mockResolvedValue({ ...domain, hostname: "www.example.com" });
    projectRepo.findById.mockResolvedValue({ ...project, workspaceId: "workspace-1" });
    planRecords.mockClear();
    provisionRecords.mockClear();
  });

  it("shows and appends the exact parent TXT through the same plan and apply", async () => {
    cloud.verify.mockResolvedValue({
      verified: false, cname: true, ownership: false,
      required_records: { cname: route, txt: parentProof },
    });
    const { records } = await getDomainRecords(ctx, domain.id);
    expect(records).toEqual([expect.objectContaining({
      type: "TXT", host: "_opsh", name: "_opsh.example.com", value: parentProof.value,
    })]);
    await planDomainDns(ctx, domain.id);
    await applyDomainDns(ctx, domain.id);
    const inputs = [{ type: "TXT", name: parentProof.host, content: parentProof.value, append: true }];
    expect(planRecords).toHaveBeenCalledWith(ctx.organizationId, "www.example.com", inputs);
    expect(provisionRecords).toHaveBeenCalledWith(ctx.organizationId, "www.example.com", inputs);
    expect(cloud.getClient).toHaveBeenCalledWith(ctx.organizationId, "workspace-1");
    expect(cloud.verify).toHaveBeenCalledWith({ domain: "www.example.com" });
    expect(cloud.authorize).toHaveBeenCalledWith(expect.objectContaining({ scopeMode: "fixed" }), {
      resourceType: "settings", resourceId: "*", action: "admin",
    });
    expect(cloud.requireAdmin).toHaveBeenCalledWith(ctx);
  });

  it.each(["scope", "role"])("blocks a zone proof write if the DNS %s check fails", async (deniedBy) => {
    cloud.verify.mockResolvedValue({
      verified: false, cname: true, ownership: false,
      required_records: { cname: route, txt: parentProof },
    });
    (deniedBy === "scope" ? cloud.authorize : cloud.requireAdmin)
      .mockRejectedValueOnce(Object.assign(new Error("Requires DNS administration"), { statusCode: 403 }));
    // DNS instructions are still available for manual setup.
    expect((await getDomainRecords(ctx, domain.id)).records).toHaveLength(1);
    await expect(applyDomainDns(ctx, domain.id)).rejects.toMatchObject({ statusCode: 403 });
    expect(provisionRecords).not.toHaveBeenCalled();
  });

  it("resolves a legacy project's managed server before showing a proof", async () => {
    projectRepo.findById.mockResolvedValue({ ...project, workspaceId: null, serverId: "legacy-server" });
    cloud.workspaceForServer.mockResolvedValue({ workspace: { id: "legacy-workspace" } });
    cloud.verify.mockResolvedValue({
      verified: false, cname: true, ownership: false, required_records: { cname: route, txt: parentProof },
    });
    expect((await getDomainRecords(ctx, domain.id)).records).toMatchObject([{ name: parentProof.host }]);
    expect(cloud.workspaceForServer).toHaveBeenCalledWith(ctx.organizationId, "legacy-server");
    expect(cloud.getClient).toHaveBeenCalledWith(ctx.organizationId, "legacy-workspace");
  });

  it("uses an owned active release's managed server for older project records", async () => {
    projectRepo.findById.mockResolvedValue({ ...project, workspaceId: null, activeDeploymentId: "dep-live" });
    cloud.findDeployment.mockResolvedValue({
      id: "dep-live", projectId: project.id, organizationId: ctx.organizationId,
      meta: { deployTarget: "cloud", serverId: "legacy-server" },
    });
    cloud.workspaceForServer.mockResolvedValue({ workspace: { id: "legacy-workspace" } });
    cloud.verify.mockResolvedValue({ verified: true, cname: true, ownership: true });
    expect(await verifyDomain(ctx, domain.id, { deferSsl: true })).toMatchObject({ verified: true });
    expect(cloud.getClient).toHaveBeenCalledWith(ctx.organizationId, "legacy-workspace");
  });

  it("asks for a managed server when the project has no authoritative target", async () => {
    projectRepo.findById.mockResolvedValue({ ...project, workspaceId: null });
    await expect(getDomainRecords(ctx, domain.id)).rejects.toMatchObject({ code: "CLOUD_DOMAIN_SERVER_REQUIRED" });
    await expect(applyDomainDns(ctx, domain.id)).rejects.toMatchObject({ code: "CLOUD_DOMAIN_SERVER_REQUIRED" });
    expect(cloud.getClient).not.toHaveBeenCalled();
    expect(provisionRecords).not.toHaveBeenCalled();
  });

  it("omits the TXT prompt and still requires routing for a sibling", async () => {
    cloud.verify.mockResolvedValue({
      verified: false, cname: false, ownership: true,
      required_records: { cname: route, txt: parentProof },
    });
    expect((await getDomainRecords(ctx, domain.id)).records).toEqual([
      { type: "CNAME", host: "www", name: "www.example.com", value: route.target },
    ]);
    await applyDomainDns(ctx, domain.id);
    expect(cloud.authorize).not.toHaveBeenCalled();
    expect(cloud.requireAdmin).not.toHaveBeenCalled();
    expect(provisionRecords).toHaveBeenCalledWith(ctx.organizationId, "www.example.com", [
      { type: "CNAME", name: "www.example.com", content: route.target },
    ]);
    domainRepo.recordVerifyFailure.mockResolvedValueOnce(1);
    expect(await verifyDomain(ctx, domain.id)).toMatchObject({
      verified: false, cnameVerified: false, txtVerified: true,
      message: "Add CNAME www.example.com → edge.example.com to verify www.example.com.",
    });
  });

  it("verifies the managed hostname without asking for an OpenShip TXT", async () => {
    domainRepo.listByProject.mockResolvedValue([]);
    cloud.verify.mockResolvedValue({ verified: true, cname: true, ownership: true });
    expect(await verifyDomain(ctx, domain.id, { deferSsl: true })).toMatchObject({
      verified: true, cnameVerified: true, txtVerified: true,
    });
    expect(domainRepo.markVerifiedActive).toHaveBeenCalledWith(domain.id, {
      sslStatus: "provisioning", promote: { projectId: project.id },
    });
  });

  it("does not plan a TXT write for a name outside the requested domain ancestry", async () => {
    cloud.verify.mockResolvedValue({
      verified: false, cname: true, ownership: false,
      required_records: { cname: route, txt: { ...parentProof, host: "_opsh.other.example.com" } },
    });
    await expect(planDomainDns(ctx, domain.id)).rejects.toMatchObject({ code: "CLOUD_DOMAIN_DNS_UNAVAILABLE" });
    expect(planRecords).not.toHaveBeenCalled();
  });
});

// The application seams moved with the shared engine.
vi.mock("@repo/platform/engine/lib/platform-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/controller-helpers")>();
  return { ...actual, platform: () => ({ target: cloud.enabled ? "cloud" : "local", runtime: {} }) };
});

vi.mock("@repo/platform/engine/lib/resource-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/controller-helpers")>();
  return { ...actual, platform: () => ({ target: cloud.enabled ? "cloud" : "local", runtime: {} }) };
});
