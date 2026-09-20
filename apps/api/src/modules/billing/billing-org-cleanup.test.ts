import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ env: { CLOUD_MODE: true }, org: {} as Record<string, unknown>, subscriptions: [] as unknown[] }));
vi.mock("@repo/platform/engine/config/env", () => ({ env: h.env }));
vi.mock("@repo/db", () => ({
  and: vi.fn(), eq: vi.fn(), inArray: vi.fn(),
  schema: { billingSubscription: { id: "id", organizationId: "organizationId", status: "status" } },
  repos: { organization: { findById: async () => h.org } },
  db: { select: () => ({ from: () => ({ where: async () => h.subscriptions }) }) },
}));
// Any old direct billing cleanup is a test failure, including after local rows vanish.
vi.mock("@repo/platform/engine/lib/stripe-client", () => ({ stripe: () => { throw new Error("Direct Stripe is retired"); } }));
import { getOrgBillingState } from "@repo/platform/engine/modules/billing/billing-org-cleanup";

beforeEach(() => { h.env.CLOUD_MODE = true; h.org = {}; h.subscriptions = []; });
describe("organization deletion under provider billing", () => {
  it("does not treat a canceled entitlement and empty local subscription table as settled billing", async () => {
    h.org = { oblienNamespace: "ns-a", subscriptionStatus: "canceled" };
    expect(await getOrgBillingState("org-a")).toMatchObject({ blocking: true, summary: expect.stringContaining("Contact support") });
  });
  it("protects new cloud organizations while asynchronous namespace onboarding is still pending", async () => {
    expect(await getOrgBillingState("org-a")).toMatchObject({ blocking: true });
  });
  it("allows an ordinary self-hosted organization to be deleted", async () => {
    h.env.CLOUD_MODE = false;
    expect(await getOrgBillingState("org-a")).toMatchObject({ blocking: false });
  });
  it("retains a legacy billing account for migration without calling Stripe", async () => {
    h.env.CLOUD_MODE = false;
    h.org = { stripeCustomerId: "cus_legacy" };
    expect(await getOrgBillingState("org-a")).toMatchObject({ blocking: true });
  });
});
