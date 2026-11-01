import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ manage: vi.fn() }));
vi.mock("@repo/db", () => ({
  repos: {
    domain: {
      findByHostname: async (hostname: string) => ({ id: hostname, hostname, projectId: "p" }),
    },
    project: { findById: async () => ({ id: "p", organizationId: "org" }) },
  },
}));
vi.mock("@repo/platform/engine/lib/domain-ssl", () => ({ manageDomainSsl: h.manage }));
import { renew } from "@repo/platform/engine/modules/deployments/ssl.service";
const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
beforeEach(() => {
  h.manage.mockReset();
});
describe("renewal response truthfulness", () => {
  it.each([false, undefined])(
    "does not report success without verification proof (%s)",
    async (verified) => {
      h.manage.mockResolvedValue({
        verified,
        expiresAt,
        reason: "edge_invalid",
        detail: "Wrong hostname",
      });
      expect(await renew("example.com", "org")).toMatchObject({
        success: false,
        message: "Wrong hostname",
      });
    },
  );
  it("returns a distinct pending outcome after an accepted renewal", async () => {
    h.manage.mockResolvedValue({
      verified: false,
      expiresAt,
      reason: "pending",
      detail: "Checking HTTPS",
    });
    expect(await renew("example.com", "org")).toMatchObject({
      success: false,
      pending: true,
      status: "provisioning",
    });
  });
  it("keeps a www problem separate from a working apex", async () => {
    h.manage
      .mockResolvedValueOnce({ verified: true, expiresAt })
      .mockResolvedValueOnce({ verified: false, expiresAt, reason: "pending" });
    const result = await renew("example.com", "org", true);
    expect(result.success).toBe(true);
    expect(result.results).toMatchObject([
      { domain: "example.com", success: true },
      { domain: "www.example.com", success: false, pending: true },
    ]);
  });
});
