import "../mail/_setup-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "@repo/adapters";

// reuseServerCertForDomain adopts an SSL cert the box ALREADY serves (Openship
// re-migration, or a foreign proxy we're taking over) instead of re-issuing via
// ACME — reading it on the HOST executor so it works even when the API runs in a
// container whose own /etc/letsencrypt is a different (empty) volume.

const domainRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  markVerified: vi.fn(),
  updateSsl: vi.fn(),
  listByProject: vi.fn().mockResolvedValue([]),
  setPrimary: vi.fn(),
}));
const projectRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const deploymentRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const serverRepo = vi.hoisted(() => ({ getInOrganization: vi.fn() }));

const sslMocks = vi.hoisted(() => ({
  verifyExistingCert: vi.fn(),
  installDomainCert: vi.fn(),
  manageDomainSsl: vi.fn(),
  provisionDomainCertForVerify: vi.fn(),
}));
const scanProxyRoutesWithExecutor = vi.hoisted(() => vi.fn());
// The host executor createHostExecutor() returns — swapped per test.
const hostExec = vi.hoisted(() => ({ current: null as CommandExecutor | null }));

vi.mock("@repo/db", () => ({
  repos: {
    domain: domainRepo,
    project: projectRepo,
    deployment: deploymentRepo,
    server: serverRepo,
  },
}));

vi.mock("../../../src/lib/controller-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/controller-helpers")>();
  return { ...actual, platform: () => ({ target: "local", runtime: {} }) };
});

vi.mock("../../../src/lib/domain-ssl", () => sslMocks);
vi.mock("../../../src/modules/migration/proxy-route-scan", () => ({ scanProxyRoutesWithExecutor }));
vi.mock("../../../src/lib/ssh-manager", () => ({
  sshManager: { withExecutor: vi.fn(async (_id: string, fn: (e: CommandExecutor) => unknown) => fn(hostExec.current!)) },
}));
vi.mock("@repo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/adapters")>();
  return { ...actual, createHostExecutor: () => hostExec.current };
});

import { reuseServerCertForDomain } from "../../../src/modules/domains/domain.service";

/** Fake executor: `exists` answers the container markers from `container`, and
 *  file existence from `files`; `readFile` returns file contents or throws. */
function fakeExecutor(files: Record<string, string>, container = false): CommandExecutor {
  return {
    exists: async (p: string) =>
      p === "/.dockerenv" || p === "/run/.containerenv" ? container : p in files,
    readFile: async (p: string) => {
      if (p in files) return files[p];
      throw new Error(`ENOENT: ${p}`);
    },
  } as unknown as CommandExecutor;
}

const HOST = "app.example.com";
const domainRow = {
  id: "dom_1",
  projectId: "proj_1",
  hostname: HOST,
  domainType: "custom",
  verified: false,
  sslStatus: "none",
  isPrimary: false,
};
const project = {
  id: "proj_1",
  organizationId: "org_1",
  activeDeploymentId: "dep_1",
  cloudWorkspaceId: null,
};
const ctx = { organizationId: "org_1", userId: "u_1" } as never;

const LIVE = `/etc/letsencrypt/live/${HOST}`;

beforeEach(() => {
  vi.clearAllMocks();
  domainRepo.findById.mockResolvedValue({ ...domainRow });
  domainRepo.listByProject.mockResolvedValue([]);
  projectRepo.findById.mockResolvedValue({ ...project });
  deploymentRepo.findById.mockResolvedValue({ id: "dep_1", meta: { serverId: "srv_1" } });
  serverRepo.getInOrganization.mockResolvedValue({ id: "srv_1", isLocal: true });
  sslMocks.verifyExistingCert.mockResolvedValue({ verified: false });
  sslMocks.installDomainCert.mockResolvedValue({ expiresAt: "2027-01-01T00:00:00.000Z", verified: true });
  scanProxyRoutesWithExecutor.mockResolvedValue(new Map());
  hostExec.current = fakeExecutor({});
});

afterEach(() => {
  delete process.env.OPENSHIP_EDGE_MODE;
});

describe("reuseServerCertForDomain", () => {
  it("reuses certbot's existing cert when the platform provider already sees it", async () => {
    sslMocks.verifyExistingCert.mockResolvedValue({ verified: true, issuer: "certbot", expiresAt: "2027-01-01" });

    const ok = await reuseServerCertForDomain(ctx, "dom_1");

    expect(ok).toBe(true);
    expect(domainRepo.markVerified).toHaveBeenCalledWith("dom_1");
    expect(domainRepo.updateSsl).toHaveBeenCalledWith("dom_1", expect.objectContaining({ sslStatus: "active" }));
    expect(sslMocks.installDomainCert).not.toHaveBeenCalled();
  });

  it("reads the HOST's /etc/letsencrypt directly (bare-edge: container volume is empty)", async () => {
    hostExec.current = fakeExecutor({
      [`${LIVE}/fullchain.pem`]: "HOST_CERT",
      [`${LIVE}/privkey.pem`]: "HOST_KEY",
    });

    const ok = await reuseServerCertForDomain(ctx, "dom_1");

    expect(ok).toBe(true);
    expect(sslMocks.installDomainCert).toHaveBeenCalledWith(
      HOST,
      { certPem: "HOST_CERT", keyPem: "HOST_KEY" },
      expect.objectContaining({ allowUnverified: true }),
    );
    expect(domainRepo.markVerified).toHaveBeenCalledWith("dom_1");
  });

  it("migrates a FOREIGN proxy's cert referenced by its vhost", async () => {
    scanProxyRoutesWithExecutor.mockResolvedValue(
      new Map([[443, { port: 443, domains: [HOST], ssl: { enabled: true, certPath: "/foreign/cert.pem", keyPath: "/foreign/key.pem" } }]]),
    );
    hostExec.current = fakeExecutor({
      "/foreign/cert.pem": "FOREIGN_CERT",
      "/foreign/key.pem": "FOREIGN_KEY",
    });

    const ok = await reuseServerCertForDomain(ctx, "dom_1");

    expect(ok).toBe(true);
    expect(sslMocks.installDomainCert).toHaveBeenCalledWith(
      HOST,
      { certPem: "FOREIGN_CERT", keyPem: "FOREIGN_KEY" },
      expect.objectContaining({ allowUnverified: true }),
    );
  });

  it("stays pending when no cert is reusable anywhere", async () => {
    const ok = await reuseServerCertForDomain(ctx, "dom_1");

    expect(ok).toBe(false);
    expect(sslMocks.installDomainCert).not.toHaveBeenCalled();
    expect(domainRepo.markVerified).not.toHaveBeenCalled();
  });

  it("skips (no silent container write) when the host is unreachable from the container", async () => {
    // Bare edge + the host executor lands in a container (has /.dockerenv) and
    // can't reach the host's OpenResty/certs → reuse must not run.
    hostExec.current = fakeExecutor(
      { [`${LIVE}/fullchain.pem`]: "HOST_CERT", [`${LIVE}/privkey.pem`]: "HOST_KEY" },
      /* container */ true,
    );

    const ok = await reuseServerCertForDomain(ctx, "dom_1");

    expect(ok).toBe(false);
    expect(sslMocks.installDomainCert).not.toHaveBeenCalled();
    expect(domainRepo.markVerified).not.toHaveBeenCalled();
  });

  it("does NOT treat docker-edge mode as unreachable (shared cert volume)", async () => {
    // Containerized openship-edge shares /etc/letsencrypt with the API, so the
    // /.dockerenv marker must NOT block reuse there.
    process.env.OPENSHIP_EDGE_MODE = "docker";
    hostExec.current = fakeExecutor(
      { [`${LIVE}/fullchain.pem`]: "HOST_CERT", [`${LIVE}/privkey.pem`]: "HOST_KEY" },
      /* container */ true,
    );

    const ok = await reuseServerCertForDomain(ctx, "dom_1");

    expect(ok).toBe(true);
    expect(sslMocks.installDomainCert).toHaveBeenCalled();
  });
});
