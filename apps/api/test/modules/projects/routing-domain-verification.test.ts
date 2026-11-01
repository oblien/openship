import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";

const mocks = vi.hoisted(() => ({
  project: { findById: vi.fn() },
  deployment: { findById: vi.fn() },
  server: { get: vi.fn(), getInOrganization: vi.fn() },
  service: { listByProject: vi.fn() },
  domain: {
    listByProject: vi.fn(),
    findById: vi.fn(),
    markVerifiedActive: vi.fn(),
    markVerified: vi.fn(),
    updateSsl: vi.fn(),
    setPrimary: vi.fn(),
    recordVerifyFailure: vi.fn(),
  },
  verifyCert: vi.fn(),
  provisionCert: vi.fn(),
  manageSsl: vi.fn(),
  probe: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock("@repo/db", async (original) => ({
  ...(await original<typeof import("@repo/db")>()),
  repos: {
    project: mocks.project,
    deployment: mocks.deployment,
    server: mocks.server,
    service: mocks.service,
    domain: mocks.domain,
  },
}));
vi.mock("@repo/platform/engine/lib/platform-config", () => ({
  platform: () => ({ target: "local", runtime: { name: "docker" } }),
}));
vi.mock("@repo/platform/engine/lib/authorization", () => ({
  authorization: { authorize: mocks.authorize },
}));
vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({
  audit: { recordAsync: vi.fn() },
  operationAuditContext: (ctx: unknown) => ctx,
}));
vi.mock("@repo/platform/engine/lib/notification-dispatcher", () => ({
  notification: { emit: vi.fn() },
}));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: { probeReachable: mocks.probe },
}));
vi.mock("@repo/platform/engine/lib/domain-ssl", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/domain-ssl")>()),
  verifyExistingCert: mocks.verifyCert,
  provisionDomainCertForVerify: mocks.provisionCert,
  manageDomainSsl: mocks.manageSsl,
}));

// Keep domain.service real: this exercises the same persisted Pending → Active
// transition and certificate reuse that the interactive Verify operation uses.
import { verifyProjectRoutingDomains } from "@repo/platform/engine/modules/domains/domain.operations";
import { verifyDomain } from "@repo/platform/engine/modules/domains/domain.service";

type Row = {
  id: string;
  projectId: string;
  serviceId: string | null;
  hostname: string;
  port: number;
  domainType: string | null;
  verified: boolean;
  status: string;
  sslStatus: string;
  isPrimary: boolean;
  externalIngress?: boolean;
  manualSsl?: boolean;
  lastVerifyError?: string;
};
let rows: Row[];
const context = {
  organizationId: "org-a",
  userId: "owner",
  scopeMode: "fixed",
} as ExecutionContext;
const expiresAt = new Date(Date.now() + 120 * 86_400_000).toISOString();
function domain(name: string, port: number, extra: Partial<Row> = {}): Row {
  return {
    id: `dom-${name}`,
    projectId: "project-a",
    serviceId: `svc-${name}`,
    hostname: `${name}.example.com`,
    port,
    domainType: "custom",
    verified: false,
    status: "pending",
    sslStatus: "none",
    isPrimary: false,
    ...extra,
  };
}
const get = (id: string) => rows.find((row) => row.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  rows = [domain("api", 4010), domain("app", 3021), domain("web", 3022)];
  mocks.project.findById.mockResolvedValue({
    id: "project-a",
    organizationId: "org-a",
    serverId: "server-remote",
    activeDeploymentId: "deploy-a",
  });
  mocks.deployment.findById.mockResolvedValue({
    id: "deploy-a",
    projectId: "project-a",
    organizationId: "org-a",
    meta: { serverId: "server-remote" },
  });
  const server = {
    id: "server-remote",
    organizationId: "org-a",
    isLocal: false,
    sshHost: "192.0.2.5",
  };
  mocks.server.get.mockResolvedValue(server);
  mocks.server.getInOrganization.mockResolvedValue(server);
  mocks.service.listByProject.mockImplementation(async () =>
    rows
      .filter((row) => row.serviceId)
      .map((row) => ({ id: row.serviceId, enabled: true, exposed: true })),
  );
  mocks.domain.listByProject.mockImplementation(async () => rows.map((row) => ({ ...row })));
  mocks.domain.findById.mockImplementation(async (id) => ({ ...get(id) }));
  mocks.domain.markVerifiedActive.mockImplementation(async (id, patch) =>
    Object.assign(get(id), patch, { verified: true, status: "active" }),
  );
  mocks.domain.markVerified.mockImplementation(async (id) =>
    Object.assign(get(id), { verified: true, status: "active" }),
  );
  mocks.domain.updateSsl.mockImplementation(async (id, patch) => Object.assign(get(id), patch));
  mocks.domain.recordVerifyFailure.mockImplementation(async (id, message) => {
    Object.assign(get(id), { status: "failed", lastVerifyError: message });
    return 1;
  });
  mocks.probe.mockResolvedValue(true);
  mocks.authorize.mockImplementation(async (ctx) => ctx);
  mocks.verifyCert.mockResolvedValue({ verified: true, issuer: "certbot", expiresAt });
  mocks.provisionCert.mockResolvedValue({ verified: false, reason: "missing" });
  mocks.manageSsl.mockResolvedValue({ verified: true, expiresAt });
});

describe("routing repair domain verification", () => {
  it("moves all three pending service domains to Active using certificates already on the remote server", async () => {
    const logs: string[] = [];
    expect(
      await verifyProjectRoutingDomains(context, "project-a", (line) => logs.push(line)),
    ).toEqual([]);
    expect(
      rows.every((row) => row.verified && row.status === "active" && row.sslStatus === "active"),
    ).toBe(true);
    expect(mocks.domain.markVerifiedActive).toHaveBeenCalledTimes(3);
    expect(mocks.provisionCert).not.toHaveBeenCalled();
    expect(mocks.manageSsl).not.toHaveBeenCalled();
    for (const row of rows) {
      expect(mocks.authorize).toHaveBeenCalledWith(context, {
        resourceType: "domain",
        resourceId: row.id,
        action: "write",
      });
      expect(mocks.verifyCert).toHaveBeenCalledWith(row.hostname, {
        projectId: "project-a",
        activate: true,
      });
      expect(logs.some((line) => line.includes(row.hostname) && line.includes("reusing it"))).toBe(
        true,
      );
    }
    expect(mocks.probe).toHaveBeenCalledTimes(3);
    expect(mocks.probe.mock.calls.every(([id]) => id === "server-remote")).toBe(true);
    // A second Retry is safe: healthy rows need no certificate work.
    await verifyProjectRoutingDomains(context, "project-a");
    expect(mocks.verifyCert).toHaveBeenCalledTimes(3);
  });

  it("records a failed check, reports the real cause, and still verifies healthy siblings", async () => {
    mocks.verifyCert.mockImplementation(async (hostname) =>
      hostname.startsWith("api.")
        ? { verified: false, reason: "missing" }
        : { verified: true, expiresAt },
    );
    mocks.provisionCert.mockRejectedValue(
      new Error("HTTP challenge returned 404 from the origin proxy"),
    );
    const warnings = await verifyProjectRoutingDomains(context, "project-a");
    expect(warnings).toEqual([
      "api.example.com: HTTP challenge returned 404 from the origin proxy",
    ]);
    expect(get("dom-api")).toMatchObject({ verified: false, status: "failed", sslStatus: "none" });
    expect(get("dom-app")).toMatchObject({ verified: true, status: "active", sslStatus: "active" });
    expect(get("dom-web")).toMatchObject({ verified: true, status: "active", sslStatus: "active" });
    expect(mocks.domain.recordVerifyFailure).toHaveBeenCalledWith(
      "dom-api",
      "HTTP challenge returned 404 from the origin proxy",
    );
    expect(mocks.manageSsl).not.toHaveBeenCalled();
  });

  it("reports an unreachable remote host without inventing a missing certificate or changing SSL state", async () => {
    rows = [domain("api", 4010, { sslStatus: "active" })];
    mocks.probe.mockResolvedValue(false);
    const warnings = await verifyProjectRoutingDomains(context, "project-a");
    expect(warnings[0]).toContain("Can't reach 192.0.2.5 over SSH");
    expect(get("dom-api").sslStatus).toBe("active");
    expect(mocks.verifyCert).not.toHaveBeenCalled();
    expect(mocks.provisionCert).not.toHaveBeenCalled();
  });

  it("checks SSL for a domain already verified but still lacking HTTPS", async () => {
    rows = [domain("api", 4010, { verified: true, status: "active" })];
    mocks.manageSsl.mockImplementation(async () => {
      get("dom-api").sslStatus = "active";
      return { verified: true, expiresAt };
    });
    expect(await verifyProjectRoutingDomains(context, "project-a", vi.fn())).toEqual([]);
    expect(mocks.manageSsl).toHaveBeenCalledWith(
      "api.example.com",
      expect.objectContaining({
        action: "provision",
        projectId: "project-a",
        onLog: expect.any(Function),
      }),
    );
    expect(get("dom-api").sslStatus).toBe("active");
    expect(mocks.provisionCert).not.toHaveBeenCalled();
  });

  it("leaves disabled services and managed or operator-owned TLS alone", async () => {
    rows = [
      domain("api", 4010),
      domain("app", 3021, { domainType: "free" }),
      domain("web", 3022, { verified: true, manualSsl: true }),
      domain("external", 80, { verified: true, externalIngress: true }),
    ];
    mocks.service.listByProject.mockImplementation(async () =>
      rows.map((row) => ({ id: row.serviceId, enabled: row.id !== "dom-api", exposed: true })),
    );
    expect(await verifyProjectRoutingDomains(context, "project-a")).toEqual([]);
    expect(mocks.verifyCert).not.toHaveBeenCalled();
    expect(mocks.provisionCert).not.toHaveBeenCalled();
    expect(mocks.manageSsl).not.toHaveBeenCalled();
  });

  it.each(["none", "error"])(
    "interactive verification completes HTTPS for an already verified domain with SSL %s",
    async (sslStatus) => {
      rows = [domain("api", 4010, { verified: true, status: "active", sslStatus })];
      expect(await verifyDomain(context, "dom-api")).toMatchObject({
        verified: true,
        sslStatus: "active",
      });
      expect(mocks.manageSsl).toHaveBeenCalledWith(
        "api.example.com",
        expect.objectContaining({ action: "provision", projectId: "project-a" }),
      );
      expect(mocks.provisionCert).not.toHaveBeenCalled();
      expect(mocks.domain.recordVerifyFailure).not.toHaveBeenCalled();
    },
  );

  it("reports a failed interactive TLS check instead of returning Already verified", async () => {
    const message = "Connection lost while reading the server's HTTPS certificate";
    rows = [
      domain("api", 4010, {
        verified: true,
        status: "active",
        sslStatus: "error",
        lastVerifyError: message,
      }),
    ];
    mocks.manageSsl.mockResolvedValue({ verified: false, expiresAt: "", reason: "read_error" });
    await expect(verifyDomain(context, "dom-api")).rejects.toThrow(message);
    // The SSL primitive owns this failure; the verification wrapper must not count it twice.
    expect(mocks.domain.recordVerifyFailure).not.toHaveBeenCalled();
  });
});
