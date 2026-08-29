import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #427 follow-up — the WRITE-path free-route gate on a self-hosted box with its own
 * HOST_DOMAIN (routing base != CLOUD_DOMAIN).
 *
 * `getRoutingBaseDomain() = HOST_DOMAIN || CLOUD_DOMAIN`, so a free subdomain here
 * composes to `<slug>.<HOST_DOMAIN>` — served by the operator's OWN edge, not the
 * Cloud edge. The write gate must therefore NOT call requireCloud for it, while a
 * route that genuinely resolves under `*.opsh.io` STILL must. This mirrors the
 * deploy-path proof in preflight-selfhosted-hostdomain.test.ts across the same
 * predicate, so create/update and deploy cannot diverge.
 *
 * `env` is parsed once at import, so HOST_DOMAIN is set in process.env from a
 * `vi.hoisted` block (runs before the hoisted module imports evaluate) — the REAL
 * `getRoutingBaseDomain()` then returns it consistently for every importer.
 */

vi.hoisted(() => {
  process.env.HOST_DOMAIN = "apps.example.com";
});

const { requireCloud } = vi.hoisted(() => ({ requireCloud: vi.fn() }));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return { ...actual, repos: {} };
});

vi.mock("../../src/lib/cloud/require-cloud", () => ({ requireCloud }));

import { assertFreeEndpointsAllowed } from "../../src/lib/free-domain-guard";

// process.env is process-global; a reused worker could carry HOST_DOMAIN into a
// later file's fresh env parse, so shield subsequent files.
afterAll(() => {
  delete process.env.HOST_DOMAIN;
});

describe("assertFreeEndpointsAllowed — self-hosted HOST_DOMAIN (#427)", () => {
  beforeEach(() => {
    requireCloud.mockReset();
    requireCloud.mockResolvedValue(undefined);
  });

  it("does NOT require Cloud for a free subdomain on the operator's own HOST_DOMAIN", async () => {
    // slug "api" → api.apps.example.com → the operator's own edge, not *.opsh.io.
    await assertFreeEndpointsAllowed("org-1", [{ domainType: "free", domain: "api" }] as any);
    expect(requireCloud).not.toHaveBeenCalled();
  });

  it("does NOT require Cloud for a custom domain", async () => {
    await assertFreeEndpointsAllowed("org-1", [{ domainType: "custom", customDomain: "shop.example.com" }] as any);
    expect(requireCloud).not.toHaveBeenCalled();
  });

  it("STILL requires Cloud for a route that resolves under the real Cloud domain (*.opsh.io)", async () => {
    // A stray route pointed at the Cloud edge needs Cloud even on a self-hosted box.
    await assertFreeEndpointsAllowed(
      "org-1",
      [{ domainType: "custom", customDomain: "legacy.opsh.io" }] as any,
      "managed-compose-domains",
    );
    expect(requireCloud).toHaveBeenCalledTimes(1);
    expect(requireCloud).toHaveBeenCalledWith("managed-compose-domains", { organizationId: "org-1" });
  });
});
