import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #427 follow-up — the WRITE-path free-route gate (create/update project & service),
 * on the DEFAULT/SaaS config (HOST_DOMAIN unset, routing base == CLOUD_DOMAIN).
 *
 * assertFreeEndpointsAllowed delegates entirely to storedPublicEndpointsNeedCloud
 * (only a *.opsh.io route needs the Cloud edge) then to requireCloud. This file
 * proves the Cloud requirement STILL fires on the write path for a genuine free
 * subdomain and forwards the capability — i.e. the #427 predicate change did not
 * loosen Cloud gating. The self-hosted-HOST_DOMAIN isolation half is pinned in
 * free-domain-guard-hostdomain.test.ts (same predicate, different routing base).
 */

const { requireCloud } = vi.hoisted(() => ({ requireCloud: vi.fn() }));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return { ...actual, repos: {} };
});

vi.mock("../../src/lib/cloud/require-cloud", () => ({ requireCloud }));

import { assertFreeEndpointsAllowed } from "../../src/lib/free-domain-guard";

describe("assertFreeEndpointsAllowed — default/SaaS base (#427)", () => {
  beforeEach(() => {
    requireCloud.mockReset();
    requireCloud.mockResolvedValue(undefined);
  });

  it("requires Cloud for a genuine free subdomain, forwarding the default capability", async () => {
    // base == opsh.io, so slug "api" composes to api.opsh.io → behind the Cloud edge.
    await assertFreeEndpointsAllowed("org-1", [{ domainType: "free", domain: "api" }] as any);
    expect(requireCloud).toHaveBeenCalledTimes(1);
    expect(requireCloud).toHaveBeenCalledWith("managed-project-domain", { organizationId: "org-1" });
  });

  it("forwards an explicit capability (e.g. compose services)", async () => {
    await assertFreeEndpointsAllowed(
      "org-1",
      [{ domainType: "free", domain: "web" }] as any,
      "managed-compose-domains",
    );
    expect(requireCloud).toHaveBeenCalledWith("managed-compose-domains", { organizationId: "org-1" });
  });

  it("does NOT require Cloud for a custom domain", async () => {
    await assertFreeEndpointsAllowed("org-1", [{ domainType: "custom", customDomain: "shop.example.com" }] as any);
    expect(requireCloud).not.toHaveBeenCalled();
  });

  it("does NOT require Cloud for a mislabeled 'free' row that actually carries a custom domain", async () => {
    // domainType is intentionally unread; a real custom hostname classifies as custom.
    await assertFreeEndpointsAllowed("org-1", [{ domainType: "free", customDomain: "shop.example.com" }] as any);
    expect(requireCloud).not.toHaveBeenCalled();
  });

  it("does NOT require Cloud when there is nothing routable", async () => {
    await assertFreeEndpointsAllowed("org-1", []);
    await assertFreeEndpointsAllowed("org-1", null);
    expect(requireCloud).not.toHaveBeenCalled();
  });
});
