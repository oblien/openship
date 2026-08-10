import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A throw from certbot is NOT proof that no certificate was issued.
 *
 * The failure these tests exist to catch is the quietest one in the whole domain
 * flow. On a Windows control plane, certbot issued a real certificate and the step
 * AFTER it — the read of `live/<domain>` — looked at a backslash-joined path, found
 * nothing, and threw. The persist never ran, so the row kept
 * `sslStatus: "provisioning"` and a NULL `sslExpiresAt`, and `renewOrgCerts` skips
 * exactly that shape. The site served fine for 90 days and then lost TLS, with the
 * dashboard showing a domain that looked like it had never been issued at all.
 *
 * The path bug is fixed at the source (adapters/infra/nginx.ts joins POSIX). This
 * is the backstop: whatever makes a post-issuance step fail, a valid certificate on
 * the edge must end up recorded, because the recorded expiry is what schedules
 * renewal.
 */

const VALID_EXPIRY = new Date(Date.now() + 89 * 86_400_000).toISOString();
/** Inside SSL_RENEW_BEFORE_DAYS (14) — the near-expiry cert an issuance REPLACES. */
const NEAR_EXPIRY = new Date(Date.now() + 3 * 86_400_000).toISOString();

const h = vi.hoisted(() => ({
  domains: new Map<string, Record<string, unknown>>(),
  updateSsl: vi.fn(),
  provisionCert: vi.fn(),
  renewCert: vi.fn(),
  verifyCert: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    domain: {
      findByHostname: vi.fn(async (hostname: string) => h.domains.get(hostname) ?? null),
      updateSsl: h.updateSsl,
    },
    project: {
      findById: vi.fn(async (id: string) => ({
        id,
        organizationId: "org_1",
        activeDeploymentId: "dep_1",
      })),
    },
    deployment: {
      findById: vi.fn(async (id: string) => ({ id, organizationId: "org_1", meta: {} })),
    },
    server: { findLocal: vi.fn(async () => null) },
  },
}));

vi.mock("../../src/lib/deployment-runtime", () => ({
  resolveDeploymentPlatform: vi.fn(async () => ({
    platform: {
      ssl: {
        provisionCert: h.provisionCert,
        renewCert: h.renewCert,
        verifyCert: h.verifyCert,
      },
    },
  })),
}));

vi.mock("../../src/lib/controller-helpers", () => ({
  platform: () => ({ target: "selfhosted", runtime: {} }),
}));

vi.mock("../../src/lib/provision-lock", () => ({
  createProvisionLock: () => ({ run: <T,>(fn: () => Promise<T>) => fn() }),
}));

vi.mock("../../src/config/env", () => ({
  env: { CLOUD_MODE: false, DEPLOY_MODE: "selfhosted" },
}));

import { manageDomainSsl, provisionDomainCertForVerify } from "../../src/lib/domain-ssl";

const HOST = "app.example.com";

function domain(extra: Record<string, unknown> = {}) {
  h.domains.set(HOST, {
    id: "dom_1",
    hostname: HOST,
    projectId: "proj_1",
    verified: true,
    sslStatus: "provisioning",
    domainType: "custom",
    externalIngress: false,
    manualSsl: false,
    ...extra,
  });
}

/** What the edge reports for an on-disk cert, or "nothing there". */
function onDisk(expiresAt: string | null) {
  h.verifyCert.mockResolvedValue(
    expiresAt
      ? { domain: HOST, expiresAt, issuer: "R11", verified: true }
      : { domain: HOST, expiresAt: "", issuer: "certbot", verified: false, reason: "missing" },
  );
}

/** The post-issuance failure: certbot ran, the bookkeeping step blew up. */
const POST_ISSUE_ERROR = new Error(
  "certbot exited without an error but no certificate is at /etc/letsencrypt/live/app.example.com.",
);

beforeEach(() => {
  h.domains.clear();
  h.updateSsl.mockReset();
  h.provisionCert.mockReset();
  h.renewCert.mockReset();
  h.verifyCert.mockReset();
});

describe.each([
  {
    label: "manageDomainSsl(provision)",
    failingSpy: () => h.provisionCert,
    run: () => manageDomainSsl(HOST, { action: "provision" }),
  },
  {
    label: "manageDomainSsl(renew)",
    failingSpy: () => h.renewCert,
    run: () => manageDomainSsl(HOST, { action: "renew" }),
  },
  {
    label: "provisionDomainCertForVerify",
    failingSpy: () => h.provisionCert,
    // force skips the reuse pre-check, so verifyCert is reached only by recovery.
    run: () => provisionDomainCertForVerify(HOST, { force: true }),
  },
])("$label — a cert that got issued is never left unrecorded", ({ failingSpy, run }) => {
  it("records the expiry read off the edge when the step after issuance throws", async () => {
    domain();
    failingSpy().mockRejectedValue(POST_ISSUE_ERROR);
    onDisk(VALID_EXPIRY);

    const result = await run();

    // Reported as the success it actually was...
    expect(result.verified).toBe(true);
    expect(result.expiresAt).toBe(VALID_EXPIRY);
    // ...and, the part that matters, PERSISTED — renewOrgCerts needs both of these.
    expect(h.updateSsl).toHaveBeenCalledWith("dom_1", {
      sslStatus: "active",
      sslIssuer: "R11",
      sslExpiresAt: new Date(VALID_EXPIRY),
    });
  });

  it("rethrows when there really is no certificate on the edge", async () => {
    domain();
    failingSpy().mockRejectedValue(POST_ISSUE_ERROR);
    onDisk(null);

    await expect(run()).rejects.toThrow(POST_ISSUE_ERROR);
    // Must not claim "active" for a cert that doesn't exist.
    expect(h.updateSsl).not.toHaveBeenCalledWith("dom_1", expect.objectContaining({ sslStatus: "active" }));
  });

  it("rethrows when the only cert present is the near-expiry one it was replacing", async () => {
    // The discriminator: issuance only runs when the cert is missing, near expiry,
    // or forced. A cert still inside the renewal window therefore proves nothing
    // new was issued — treating it as success would mark the domain active and
    // schedule a renewal that already failed.
    domain();
    failingSpy().mockRejectedValue(POST_ISSUE_ERROR);
    onDisk(NEAR_EXPIRY);

    await expect(run()).rejects.toThrow(POST_ISSUE_ERROR);
    expect(h.updateSsl).not.toHaveBeenCalledWith("dom_1", expect.objectContaining({ sslStatus: "active" }));
  });

  it("rethrows when the edge itself can't be reached to check", async () => {
    domain();
    failingSpy().mockRejectedValue(POST_ISSUE_ERROR);
    h.verifyCert.mockRejectedValue(new Error("ssh: connect timed out"));

    await expect(run()).rejects.toThrow(POST_ISSUE_ERROR);
  });
});

describe("the happy path is untouched", () => {
  it("persists a normal successful issuance without consulting the edge again", async () => {
    domain();
    h.provisionCert.mockResolvedValue({
      domain: HOST,
      expiresAt: VALID_EXPIRY,
      issuer: "R11",
      verified: true,
      reason: "issued",
    });

    const result = await manageDomainSsl(HOST, { action: "provision" });

    expect(result.reason).toBe("issued");
    expect(h.verifyCert).not.toHaveBeenCalled();
    expect(h.updateSsl).toHaveBeenCalledWith("dom_1", {
      sslStatus: "active",
      sslIssuer: "R11",
      sslExpiresAt: new Date(VALID_EXPIRY),
    });
  });
});
