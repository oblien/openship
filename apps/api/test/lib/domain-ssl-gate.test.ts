import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `manageDomainSsl` is the ONE entrypoint that can open an ACME order (manual
 * Provision, the ssl:renew scheduler, the self-app edge provisioner, the boot
 * reconcile). It used to run certbot for whatever hostname it was handed, so each
 * caller carried its own "don't ask for this one" guard — five of them, in five
 * vocabularies, and a sixth caller would have had to rediscover the rule.
 *
 * These tests pin the gate that replaced them. The failure they exist to catch is
 * silent: burning a Let's Encrypt attempt on a hostname whose A record points at
 * Cloudflare or at Cloud's *.opsh.io edge, then writing "provisioning" over a
 * perfectly correct "external".
 */

const h = vi.hoisted(() => ({
  domains: new Map<string, Record<string, unknown>>(),
  updateSsl: vi.fn(),
  provisionCert: vi.fn(async (domain: string) => ({
    domain,
    expiresAt: "2030-01-01T00:00:00.000Z",
    issuer: "R3",
    verified: true,
    reason: "issued" as const,
  })),
  renewCert: vi.fn(async (domain: string) => ({
    domain,
    expiresAt: "2030-01-01T00:00:00.000Z",
    issuer: "R3",
    verified: true,
    reason: "renewed" as const,
  })),
  verifyCert: vi.fn(async (domain: string) => ({
    domain,
    expiresAt: "2030-01-01T00:00:00.000Z",
    issuer: "Operator",
    verified: true,
  })),
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

// Resolve the SSL provider through the deployment platform (the primary path) so
// the spies below ARE the provider manageDomainSsl reaches.
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

// The lock is orthogonal here — run the body inline.
vi.mock("../../src/lib/provision-lock", () => ({
  createProvisionLock: () => ({ run: <T,>(fn: () => Promise<T>) => fn() }),
}));

vi.mock("../../src/config/env", () => ({
  env: { CLOUD_MODE: false, DEPLOY_MODE: "selfhosted" },
}));

import {
  manageDomainSsl,
  resolveSslPatch,
  tlsIssuedElsewhere,
  describeTlsIssuedElsewhere,
} from "../../src/lib/domain-ssl";

/** Register a domain row the mocked repo will serve. */
function domain(hostname: string, extra: Record<string, unknown> = {}) {
  const row = {
    id: `dom_${hostname}`,
    hostname,
    projectId: "proj_1",
    verified: true,
    sslStatus: "active",
    domainType: "custom",
    externalIngress: false,
    manualSsl: false,
    ...extra,
  };
  h.domains.set(hostname, row);
  return row;
}

beforeEach(() => {
  h.domains.clear();
  h.updateSsl.mockClear();
  h.provisionCert.mockClear();
  h.renewCert.mockClear();
  h.verifyCert.mockClear();
});

describe("tlsIssuedElsewhere", () => {
  it("names each reason TLS isn't certbot's job here", () => {
    expect(tlsIssuedElsewhere({ externalIngress: true })).toBe("external_ingress");
    expect(tlsIssuedElsewhere({ manualSsl: true })).toBe("manual_cert");
    expect(tlsIssuedElsewhere({ domainType: "free" })).toBe("managed_edge");
  });

  it("returns null for the domain we DO issue for — a verified custom one", () => {
    expect(tlsIssuedElsewhere({ domainType: "custom" })).toBeNull();
    expect(
      tlsIssuedElsewhere({ domainType: "custom", externalIngress: false, manualSsl: false }),
    ).toBeNull();
  });

  it("tolerates the nullable columns as they come out of the db", () => {
    expect(tlsIssuedElsewhere({ domainType: null, externalIngress: null, manualSsl: null })).toBeNull();
  });

  it("explains itself to the operator", () => {
    expect(describeTlsIssuedElsewhere("managed_edge", "box.opsh.io")).toContain("Openship Cloud");
    expect(describeTlsIssuedElsewhere("external_ingress", "app.example.com")).toContain("your own ingress");
    expect(describeTlsIssuedElsewhere("manual_cert", "app.example.com")).toContain("uploaded certificate");
  });
});

describe("manageDomainSsl — refuses to issue what it doesn't own", () => {
  for (const [label, extra] of [
    ["a free *.opsh.io host (Cloud terminates TLS)", { domainType: "free" }],
    ["an externally-terminated domain", { externalIngress: true }],
    ["an uploaded certificate", { manualSsl: true }],
  ] as const) {
    it(`never runs certbot for ${label}`, async () => {
      domain("app.example.com", extra);
      const res = await manageDomainSsl("app.example.com", { action: "provision" });

      expect(h.provisionCert).not.toHaveBeenCalled();
      expect(res.verified).toBe(true);
      expect(res.reason).toBe("not_local");
      // No expiry claimed: we don't own that cert's lifecycle.
      expect(res.expiresAt).toBe("");
    });

    it(`never RENEWS ${label} either`, async () => {
      domain("app.example.com", extra);
      await manageDomainSsl("app.example.com", { action: "renew" });
      expect(h.renewCert).not.toHaveBeenCalled();
    });

    it(`leaves the row untouched for ${label}`, async () => {
      // The bug this prevents: writing "provisioning" over a correct "external",
      // which shows the operator a cert lifecycle nobody is driving.
      domain("app.example.com", { ...extra, sslStatus: "external" });
      await manageDomainSsl("app.example.com", { action: "provision" });
      expect(h.updateSsl).not.toHaveBeenCalled();
    });
  }

  it("STILL issues for a plain verified custom domain", async () => {
    domain("app.example.com");
    const res = await manageDomainSsl("app.example.com", { action: "provision" });

    expect(h.provisionCert).toHaveBeenCalledWith("app.example.com");
    expect(res.verified).toBe(true);
    expect(res.reason).toBe("issued");
    expect(h.updateSsl).toHaveBeenCalled();
  });

  it("lets `verify` read an uploaded cert — inspection is the whole point", async () => {
    // Gating verify would break the UI's expiry readout for a BYO cert: the file
    // IS on disk, we just didn't issue it.
    domain("app.example.com", { manualSsl: true });
    const res = await manageDomainSsl("app.example.com", { action: "verify" });

    expect(h.verifyCert).toHaveBeenCalledWith("app.example.com");
    expect(res.issuer).toBe("Operator");
  });

  // `includeWww` is gone: the sibling used to be issued INSIDE this call, and
  // unguarded — so a www that wasn't pointed here yet threw after the apex had
  // already succeeded, and the caller reported the apex as broken. `www.<apex>` is
  // its own row with its own certificate; callers ask twice and report both.
  it("touches EXACTLY ONE hostname, never the www sibling", async () => {
    domain("example.com");
    domain("www.example.com");

    await manageDomainSsl("example.com", { action: "provision" });

    expect(h.provisionCert.mock.calls.map(([d]) => d)).toEqual(["example.com"]);
  });

  it("issues for the www sibling only when IT is the domain asked for", async () => {
    domain("example.com");
    domain("www.example.com");

    await manageDomainSsl("www.example.com", { action: "provision" });

    expect(h.provisionCert.mock.calls.map(([d]) => d)).toEqual(["www.example.com"]);
  });

  it("gates a www row on its OWN flags — an external-ingress www issues nothing", async () => {
    domain("www.example.com", { externalIngress: true });

    const res = await manageDomainSsl("www.example.com", { action: "provision" });

    expect(h.provisionCert).not.toHaveBeenCalled();
    expect(res.reason).toBe("not_local");
  });
});

describe("resolveSslPatch — not_local can never clobber a status", () => {
  const notLocal = {
    domain: "app.example.com",
    expiresAt: "",
    issuer: "",
    verified: true,
    reason: "not_local" as const,
  };

  it("writes nothing, whatever the current status is", () => {
    expect(resolveSslPatch("external", notLocal)).toBeNull();
    expect(resolveSslPatch("active", notLocal)).toBeNull();
    expect(resolveSslPatch(null, notLocal)).toBeNull();
  });

  it("is distinct from `missing`, which DOES mean 'still being issued'", () => {
    expect(
      resolveSslPatch("provisioning", { ...notLocal, verified: false, reason: "missing" }),
    ).toMatchObject({ sslStatus: "provisioning" });
  });
});
