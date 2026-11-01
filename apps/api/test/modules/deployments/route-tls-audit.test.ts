import { X509Certificate } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, eq, repos, schema } from "@repo/db";
import {
  NginxProvider,
  OPENRESTY_DEFAULT_PATHS,
  type RootChecked,
  type SslProvider,
  type SslResult,
} from "@repo/adapters";
import {
  auditRoutedDomainTls,
  createTrackedSslProvider,
  type PlannedRouteDomain,
} from "@repo/platform/engine/lib/routing-domains";
import { seedOrg, seedProject } from "../../helpers/seed";
import { makeTestCert } from "../../../../../packages/adapters/src/system/proxy/test-certs";

const hostname = "app.example.com";
const activeCert: SslResult = {
  domain: hostname,
  verified: true,
  issuer: "Let's Encrypt",
  expiresAt: "2027-01-01T00:00:00.000Z",
};
const route: PlannedRouteDomain = {
  hostname,
  tls: true,
  requiresSslTooling: true,
  provisionSsl: true,
  terminatesTlsLocally: true,
  isCloud: false,
  domainType: "custom",
  targetPort: 3000,
  verified: true,
};
const certificate = makeTestCert([hostname], { issuerO: "Let's Encrypt" });

// Use the real certificate reader and validator; only the remote filesystem is
// in memory. Any attempt to issue a certificate or rewrite a route must fail.
function targetWithCertificate(pair?: { certPem: string; keyPem: string }) {
  const live = `/etc/letsencrypt/live/${hostname}`;
  const files = new Map(
    pair
      ? [
          [`${live}/fullchain.pem`, pair.certPem],
          [`${live}/privkey.pem`, pair.keyPem],
        ]
      : [],
  );
  const executor = {
    exists: async (path: string) => files.has(path),
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    exec: vi.fn().mockRejectedValue(new Error("certificate audits must not execute commands")),
    writeFile: vi.fn().mockRejectedValue(new Error("certificate audits must not write files")),
  };
  return {
    ssl: new NginxProvider({
      paths: OPENRESTY_DEFAULT_PATHS,
      executor: executor as unknown as RootChecked,
      containerEdge: true,
    }),
    executor,
  };
}

describe("deployment TLS observations and persisted certificate state", () => {
  let organizationId: string;
  let projectId: string;
  let ssl: SslProvider;

  beforeEach(async () => {
    ({ organizationId } = await seedOrg());
    projectId = (await seedProject(organizationId)).id;
    ssl = {
      provisionCert: vi.fn().mockResolvedValue(activeCert),
      renewCert: vi.fn().mockResolvedValue(activeCert),
      verifyCert: vi.fn().mockResolvedValue(activeCert),
      installCert: vi.fn().mockResolvedValue(activeCert),
    };
  }, 30_000);

  afterEach(async () => {
    await db.delete(schema.organization).where(eq(schema.organization.id, organizationId));
  });

  async function domain(sslStatus = "active") {
    return repos.domain.create({
      projectId,
      hostname,
      domainType: "custom",
      verified: true,
      verificationToken: "test",
      sslStatus,
      sslIssuer: activeCert.issuer,
      sslExpiresAt: new Date(activeCert.expiresAt),
    });
  }

  it.each(["edge_invalid", "invalid", "missing"] as const)("invalidates active Cloud metadata after a confirmed %s observation", async (reason) => {
    const stored = await domain();
    vi.mocked(ssl.verifyCert).mockResolvedValue({ ...activeCert, verified: false, reason, detail: "The certificate is not usable for this hostname" });
    const warnings = await auditRoutedDomainTls({ projectId, routes: [{ ...route, isCloud: true, terminatesTlsLocally: false }], routeWarnings: [], ssl, log: () => {} });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not usable");
    expect(await repos.domain.findById(stored.id)).toMatchObject({ sslStatus: "error", verified: true });
    expect(ssl.provisionCert).not.toHaveBeenCalled();
    expect(ssl.renewCert).not.toHaveBeenCalled();
  });

  it("keeps an accepted deploy-time certificate request pending without claiming failure", async () => {
    const stored = await domain("error");
    vi.mocked(ssl.provisionCert).mockResolvedValue({ ...activeCert, verified: false, reason: "pending" });
    const tracked = createTrackedSslProvider(ssl, new Map([[hostname, stored]]));
    expect(await tracked.provisionCert(hostname)).toMatchObject({ reason: "pending" });
    expect(await repos.domain.findById(stored.id)).toMatchObject({
      sslStatus: "provisioning", verified: true, verifyAttempts: 0, lastVerifyError: null,
    });
    expect(ssl.renewCert).not.toHaveBeenCalled();
  });

  it("preserves active Cloud TLS when the observer cannot connect", async () => {
    const stored = await domain();
    vi.mocked(ssl.verifyCert).mockResolvedValue({ ...activeCert, verified: false, reason: "read_error" });
    const warnings = await auditRoutedDomainTls({ projectId, routes: [{ ...route, isCloud: true, terminatesTlsLocally: false }], routeWarnings: [], ssl, log: () => {} });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not be checked");
    expect(await repos.domain.findById(stored.id)).toMatchObject({ sslStatus: "active", sslExpiresAt: stored.sslExpiresAt });
  });

  it("keeps an active certificate when SSH fails during the deploy-time check", async () => {
    const stored = await domain();
    vi.mocked(ssl.provisionCert).mockRejectedValue(new Error("connect ENETUNREACH 192.0.2.20:22"));
    vi.mocked(ssl.verifyCert).mockRejectedValue(new Error("connect ENETUNREACH 192.0.2.20:22"));
    const tracked = createTrackedSslProvider(ssl, new Map([[hostname, stored]]));

    expect(await tracked.provisionCert(hostname)).toMatchObject({
      verified: false,
      reason: "read_error",
    });
    expect(await repos.domain.findById(stored.id)).toMatchObject({
      sslStatus: "active",
      sslIssuer: stored.sslIssuer,
      sslExpiresAt: stored.sslExpiresAt,
    });
    expect(ssl.verifyCert).not.toHaveBeenCalled();
  });

  it("keeps a usable certificate when an issuance attempt fails for another reason", async () => {
    const stored = await domain();
    vi.mocked(ssl.provisionCert).mockRejectedValue(new Error("ACME rate limit exceeded"));
    const tracked = createTrackedSslProvider(ssl, new Map([[hostname, stored]]));

    expect(await tracked.provisionCert(hostname)).toMatchObject({ verified: true });
    expect(await repos.domain.findById(stored.id)).toMatchObject({
      sslStatus: "active",
      sslIssuer: activeCert.issuer,
      sslExpiresAt: new Date(activeCert.expiresAt),
    });
  });

  it.each(["active", "error"])(
    "preserves certificate state when the remote files cannot be read (%s)",
    async (sslStatus) => {
      const stored = await domain(sslStatus);
      const target = targetWithCertificate(certificate);
      target.executor.readFile = async () => {
        throw new Error("SSH connection closed");
      };
      const tracked = createTrackedSslProvider(target.ssl, new Map([[hostname, stored]]));

      expect(await tracked.verifyCert(hostname)).toMatchObject({ reason: "read_error" });
      expect(await repos.domain.findById(stored.id)).toMatchObject({
        sslStatus,
        sslIssuer: stored.sslIssuer,
        sslExpiresAt: stored.sslExpiresAt,
      });
    },
  );

  it("reconciles a stale record from the real certificate on the deployment target", async () => {
    const stored = await domain("provisioning");
    const target = targetWithCertificate(certificate);

    expect(
      await auditRoutedDomainTls({
        projectId,
        routes: [route],
        routeWarnings: [],
        ssl: target.ssl,
        log: () => {},
      }),
    ).toEqual([]);
    expect(await repos.domain.findById(stored.id)).toMatchObject({
      sslStatus: "active",
      sslExpiresAt: new Date(new X509Certificate(certificate.certPem).validTo),
    });
    expect(target.executor.exec).not.toHaveBeenCalled();
    expect(target.executor.writeFile).not.toHaveBeenCalled();
  });

  it.each(["read_error", "throws", "no_provider"])(
    "reports an unreadable target as unconfirmed and preserves its record (%s)",
    async (failure) => {
      const stored = await domain("error");
      await repos.domain.updateSsl(stored.id, {
        sslStatus: "error",
        lastVerifyError: "old DNS failure",
      });
      if (failure === "throws") {
        vi.mocked(ssl.verifyCert).mockRejectedValue(new Error("connect ENETUNREACH 192.0.2.20:22"));
      } else {
        vi.mocked(ssl.verifyCert).mockResolvedValue({
          domain: hostname,
          verified: false,
          expiresAt: "",
          issuer: "",
          reason: "read_error",
        });
      }

      const warnings = await auditRoutedDomainTls({
        projectId,
        routes: [route],
        routeWarnings: [],
        ssl: failure === "no_provider" ? undefined : ssl,
        log: () => {},
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("could not be");
      expect(warnings[0]).not.toMatch(/no usable|missing|DNS/);
      expect(await repos.domain.findById(stored.id)).toMatchObject({
        sslStatus: "error",
        sslIssuer: stored.sslIssuer,
        sslExpiresAt: stored.sslExpiresAt,
        lastVerifyError: "old DNS failure",
      });
      expect(ssl.provisionCert).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "wrong_hostname"])(
    "still warns when the target has no usable certificate (%s)",
    async (problem) => {
      const stored = await domain("error");
      const target = targetWithCertificate(
        problem === "wrong_hostname" ? makeTestCert(["other.example.com"]) : undefined,
      );

      const warnings = await auditRoutedDomainTls({
        projectId,
        routes: [route],
        routeWarnings: [],
        ssl: target.ssl,
        log: () => {},
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(hostname);
      expect(warnings[0]).toContain(
        problem === "missing" ? "no usable HTTPS certificate" : "invalid",
      );
      expect(await repos.domain.findById(stored.id)).toMatchObject({ sslStatus: "error" });
      expect(target.executor.exec).not.toHaveBeenCalled();
      expect(target.executor.writeFile).not.toHaveBeenCalled();
    },
  );

  it("does not add a speculative TLS warning for a host whose route update already failed", async () => {
    await domain("provisioning");
    vi.mocked(ssl.verifyCert).mockRejectedValue(new Error("connect ENETUNREACH 192.0.2.20:22"));

    expect(
      await auditRoutedDomainTls({
        projectId,
        routes: [route],
        routeWarnings: [`${hostname}: connect ENETUNREACH 192.0.2.20:22`],
        ssl,
        log: () => {},
      }),
    ).toEqual([]);
    expect(ssl.verifyCert).not.toHaveBeenCalled();
  });
});
