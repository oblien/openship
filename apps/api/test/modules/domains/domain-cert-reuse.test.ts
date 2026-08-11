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
  markVerifiedActive: vi.fn(),
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
/** The adapter's proxy read api — swapped per test to stand in for a real proxy. */
const edgeProxy = vi.hoisted(() => vi.fn());
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
// Both accessors hand back the SAME host executor, which is the point: a local
// server row and the host channel are one connection, so cert ops land on the
// host's /etc/letsencrypt either way.
vi.mock("../../../src/lib/ssh-manager", () => ({
  sshManager: {
    withExecutor: vi.fn(async (_id: string, fn: (e: CommandExecutor) => unknown) => fn(hostExec.current!)),
    withHostExecutor: vi.fn(async (fn: (e: CommandExecutor) => unknown) => fn(hostExec.current!)),
  },
}));
vi.mock("@repo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/adapters")>();
  // `validateCertFor` stays REAL: the coverage/expiry/issuer rules are exactly what
  // these tests are here to pin, and mocking them out would let a wrong-hostname
  // cert pass the suite while failing on a real box.
  return { ...actual, createHostExecutor: () => hostExec.current, edgeProxy };
});

import { validateCertFor } from "@repo/adapters";
import { makeTestCert } from "../../../../../packages/adapters/src/system/proxy/test-certs";
import { reuseServerCertForDomain } from "../../../src/modules/domains/domain.service";

/**
 * Fake executor: `exists` answers the container markers from `container` and file
 * existence from `files`; `readFile` returns contents or throws; `exec` answers the
 * certbot-lineage `ls -1d` probe by listing the lineage dirs present in `files`.
 */
function fakeExecutor(files: Record<string, string>, container = false): CommandExecutor {
  return {
    exists: async (p: string) =>
      p === "/.dockerenv" || p === "/run/.containerenv" ? container : p in files,
    readFile: async (p: string) => {
      if (p in files) return files[p];
      throw new Error(`ENOENT: ${p}`);
    },
    exec: async (cmd: string) => {
      if (!cmd.startsWith("ls -1d")) return "";
      const dirs = new Set(
        Object.keys(files)
          .filter((p) => p.startsWith("/etc/letsencrypt/live/"))
          .map((p) => p.replace(/\/[^/]+$/, "")),
      );
      return [...dirs].join("\n");
    },
  } as unknown as CommandExecutor;
}

/** An api double whose certFor/certCandidateFor answers from a fixed map. */
function fakeProxy(certs: Record<string, { certPem: string; keyPem: string }>) {
  const candidate = async (host: string) => {
    const hit = certs[host];
    if (!hit) return { cert: null, reason: `nginx: no certificate found for ${host}` };
    // Run the REAL validator so a fixture that doesn't cover the host is rejected
    // here exactly as it would be on a box.
    return validateCertFor(host, hit, `/foreign/${host}.pem`);
  };
  return {
    kind: "nginx",
    ours: false,
    container: null,
    certCandidateFor: candidate,
    certFor: async (h: string) => (await candidate(h)).cert,
  };
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

/** A real ACME-looking cert for HOST (renewable), and one that doesn't cover it. */
const HOST_CERT = makeTestCert([HOST], { issuerCN: "R11", issuerO: "Let's Encrypt" });
const ORIGIN_CERT = makeTestCert([HOST], {
  issuerCN: "Cloudflare Origin SSL CA",
  issuerO: "CloudFlare, Inc.",
});
const WRONG_HOST_CERT = makeTestCert(["someone-else.example"]);

beforeEach(() => {
  vi.clearAllMocks();
  domainRepo.findById.mockResolvedValue({ ...domainRow });
  domainRepo.listByProject.mockResolvedValue([]);
  projectRepo.findById.mockResolvedValue({ ...project });
  deploymentRepo.findById.mockResolvedValue({ id: "dep_1", meta: { serverId: "srv_1" } });
  serverRepo.getInOrganization.mockResolvedValue({ id: "srv_1", isLocal: true });
  sslMocks.verifyExistingCert.mockResolvedValue({ verified: false });
  sslMocks.installDomainCert.mockResolvedValue({ expiresAt: "2027-01-01T00:00:00.000Z", verified: true });
  edgeProxy.mockResolvedValue(null);
  hostExec.current = fakeExecutor({});
});

/** The single ssl patch `markVerifiedActive` was called with. */
const sslPatch = () => domainRepo.markVerifiedActive.mock.calls.at(-1)?.[1] ?? {};

afterEach(() => {
  delete process.env.OPENSHIP_EDGE_MODE;
});

describe("reuseServerCertForDomain", () => {
  it("reuses certbot's existing cert when the platform provider already sees it", async () => {
    sslMocks.verifyExistingCert.mockResolvedValue({ verified: true, issuer: "certbot", expiresAt: "2027-01-01" });

    const ok = await reuseServerCertForDomain(ctx, "dom_1");

    expect(ok).toBe(true);
    expect(domainRepo.markVerifiedActive).toHaveBeenCalledWith(
      "dom_1",
      expect.objectContaining({ sslStatus: "active" }),
    );
    expect(sslMocks.installDomainCert).not.toHaveBeenCalled();
  });

  it("reads the HOST's /etc/letsencrypt directly (bare-edge: container volume is empty)", async () => {
    hostExec.current = fakeExecutor({
      [`${LIVE}/fullchain.pem`]: HOST_CERT.certPem,
      [`${LIVE}/privkey.pem`]: HOST_CERT.keyPem,
    });

    const ok = await reuseServerCertForDomain(ctx, "dom_1");

    expect(ok).toBe(true);
    expect(sslMocks.installDomainCert).toHaveBeenCalledWith(
      HOST,
      expect.objectContaining({ certPem: HOST_CERT.certPem, keyPem: HOST_CERT.keyPem }),
      expect.objectContaining({ allowUnverified: true }),
    );
    expect(domainRepo.markVerifiedActive).toHaveBeenCalled();
  });

  // certbot names a lineage after its first domain and creates a `-0001` SIBLING on
  // reissue with a changed name set. Only looking at `live/<host>` missed the live
  // cert on any box whose domain set had been edited.
  it("finds a cert in a certbot `-0001` lineage dir", async () => {
    hostExec.current = fakeExecutor({
      [`${LIVE}-0001/fullchain.pem`]: HOST_CERT.certPem,
      [`${LIVE}-0001/privkey.pem`]: HOST_CERT.keyPem,
    });

    expect(await reuseServerCertForDomain(ctx, "dom_1")).toBe(true);
    expect(sslMocks.installDomainCert).toHaveBeenCalled();
  });

  it("migrates a FOREIGN proxy's cert via the proxy read api", async () => {
    edgeProxy.mockResolvedValue(fakeProxy({ [HOST]: HOST_CERT }));

    const ok = await reuseServerCertForDomain(ctx, "dom_1");

    expect(ok).toBe(true);
    expect(sslMocks.installDomainCert).toHaveBeenCalledWith(
      HOST,
      expect.objectContaining({ certPem: HOST_CERT.certPem }),
      expect.objectContaining({ allowUnverified: true }),
    );
  });

  it("stays pending when no cert is reusable anywhere", async () => {
    const ok = await reuseServerCertForDomain(ctx, "dom_1");

    expect(ok).toBe(false);
    expect(sslMocks.installDomainCert).not.toHaveBeenCalled();
    expect(domainRepo.markVerifiedActive).not.toHaveBeenCalled();
  });

  // ── The renewal fate of an adopted cert ────────────────────────────────────
  //
  // `manualSsl` makes tlsIssuedElsewhere() report "not ours to renew", which the
  // SSL scheduler filters out of every batch. Setting it unconditionally meant an
  // adopted 90-day Let's Encrypt cert was never renewed and the domain went dark
  // on day 90.

  it("does NOT set manualSsl for an ACME-issued cert, so it stays renewable", async () => {
    hostExec.current = fakeExecutor({
      [`${LIVE}/fullchain.pem`]: HOST_CERT.certPem,
      [`${LIVE}/privkey.pem`]: HOST_CERT.keyPem,
    });

    expect(await reuseServerCertForDomain(ctx, "dom_1")).toBe(true);
    expect(sslPatch()).toMatchObject({ sslIssuer: "reused" });
    expect(sslPatch()).not.toHaveProperty("manualSsl");
  });

  it("DOES set manualSsl for an origin/private CA cert certbot can't reissue", async () => {
    hostExec.current = fakeExecutor({
      [`${LIVE}/fullchain.pem`]: ORIGIN_CERT.certPem,
      [`${LIVE}/privkey.pem`]: ORIGIN_CERT.keyPem,
    });

    expect(await reuseServerCertForDomain(ctx, "dom_1")).toBe(true);
    expect(sslPatch()).toMatchObject({ manualSsl: true });
    expect(sslPatch().sslIssuer).toContain("Cloudflare");
  });

  // ── Rejections: better a pending domain than a wrong cert ──────────────────

  it("REFUSES a cert that doesn't cover the hostname", async () => {
    hostExec.current = fakeExecutor({
      [`${LIVE}/fullchain.pem`]: WRONG_HOST_CERT.certPem,
      [`${LIVE}/privkey.pem`]: WRONG_HOST_CERT.keyPem,
    });

    expect(await reuseServerCertForDomain(ctx, "dom_1")).toBe(false);
    expect(sslMocks.installDomainCert).not.toHaveBeenCalled();
    expect(domainRepo.markVerifiedActive).not.toHaveBeenCalled();
  });

  it("REFUSES an expired cert", async () => {
    const shortLived = makeTestCert([HOST], { days: 1 });
    hostExec.current = fakeExecutor({
      [`${LIVE}/fullchain.pem`]: shortLived.certPem,
      [`${LIVE}/privkey.pem`]: shortLived.keyPem,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));
    try {
      expect(await reuseServerCertForDomain(ctx, "dom_1")).toBe(false);
      expect(sslMocks.installDomainCert).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("REFUSES a mismatched cert/key pair", async () => {
    hostExec.current = fakeExecutor({
      [`${LIVE}/fullchain.pem`]: HOST_CERT.certPem,
      [`${LIVE}/privkey.pem`]: ORIGIN_CERT.keyPem, // different keypair
    });

    expect(await reuseServerCertForDomain(ctx, "dom_1")).toBe(false);
    expect(sslMocks.installDomainCert).not.toHaveBeenCalled();
  });

  it("skips (no silent container write) when the host is unreachable from the container", async () => {
    // Bare edge + the host executor lands in a container (has /.dockerenv) and
    // can't reach the host's OpenResty/certs → reuse must not run.
    hostExec.current = fakeExecutor(
      { [`${LIVE}/fullchain.pem`]: HOST_CERT.certPem, [`${LIVE}/privkey.pem`]: HOST_CERT.keyPem },
      /* container */ true,
    );

    const ok = await reuseServerCertForDomain(ctx, "dom_1");

    expect(ok).toBe(false);
    expect(sslMocks.installDomainCert).not.toHaveBeenCalled();
    expect(domainRepo.markVerifiedActive).not.toHaveBeenCalled();
  });

  it("does NOT treat docker-edge mode as unreachable (shared cert volume)", async () => {
    // Containerized openship-edge shares /etc/letsencrypt with the API, so the
    // /.dockerenv marker must NOT block reuse there.
    process.env.OPENSHIP_EDGE_MODE = "docker";
    hostExec.current = fakeExecutor(
      { [`${LIVE}/fullchain.pem`]: HOST_CERT.certPem, [`${LIVE}/privkey.pem`]: HOST_CERT.keyPem },
      /* container */ true,
    );

    const ok = await reuseServerCertForDomain(ctx, "dom_1");

    expect(ok).toBe(true);
    expect(sslMocks.installDomainCert).toHaveBeenCalled();
  });
});
