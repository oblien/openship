import { expect, it, vi } from "vitest";
import { OblienError } from "oblien";
import { OperationError } from "@repo/contracts";

const h = vi.hoisted(() => ({ mint: vi.fn() }));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: { CLOUD_MODE: true },
  runtimeTarget: {},
}));
vi.mock("@repo/db", () => ({ repos: {} }));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienClient: () => ({ tokens: { create: h.mint } }),
}));
vi.mock("@repo/platform/engine/lib/cloud-workspace-scope", () => ({
  cloudBillingOwner: async () => ({
    namespace: "ns",
    workspaceId: "space",
    workspace: { id: "space" },
  }),
}));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({
  assertNamespaceHasQuota: async () => {},
}));
vi.mock("@repo/platform/engine/lib/provision-lock", () => ({
  createProvisionLock: () => ({ run: (work: () => Promise<unknown>) => work() }),
}));
vi.mock("@repo/platform/engine/lib/cache-store/index", () => ({
  cacheStore: async () => ({ get: async () => undefined, set: async () => {} }),
}));

const { issueNamespaceToken } = await import("@repo/platform/engine/lib/openship-cloud");
it.each([429, 503])(
  "preserves transient token issuance HTTP %s and public retry guidance",
  async (status) => {
    h.mint
      .mockReset()
      .mockRejectedValue(
        new OblienError("Provider temporarily unavailable", status, "rate_limit", {
          retryAfterSeconds: 3,
          token: "private",
        }),
      );
    const error = await issueNamespaceToken("org", "space").catch((error) => error);
    expect(error).toBeInstanceOf(OperationError);
    expect(error).toMatchObject({
      statusCode: status,
      code: "rate_limit",
      details: { retryAfterSeconds: 3 },
    });
    expect(JSON.stringify(error)).not.toContain("private");
    expect(h.mint).toHaveBeenCalledTimes(1);
  },
);
