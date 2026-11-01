import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { BillingComputeSchema } from "@repo/contracts";
import { OblienBillingApi, assertOblienEntitlementMatchesSubscription } from "@repo/platform/engine/lib/oblien-billing-api";
import { monthlyCloudBilling } from "../../../test/helpers/monthly-cloud-offer";
import transfer from "../../../test/fixtures/oblien-managed-transfer.json";

// SDK 2.10's live response shape, with synthetic counters and no customer data.
const unlimited = { ...transfer, unlimited: true, includedBytes: null,
  includedAvailableBytes: null, availableBytes: null };
async function readTransfer(network: unknown, covered = true) {
  const { entitlement, subscription } = monthlyCloudBilling("org-one", "os-one");
  const payload = { ...entitlement, computeCovered: covered, capacity: {
    ...entitlement.capacity, computeCovered: covered, network,
  } };
  const api = new OblienBillingApi({ clientId: "test-id", clientSecret: "test-secret",
    fetch: (async () => Response.json(payload)) as typeof fetch });
  const result = await api.getEntitlement("os-one");
  assertOblienEntitlementMatchesSubscription(result, subscription);
  return result.capacity!;
}

describe("managed transfer provider contract", () => {
  it.each([
    ["included monthly", transfer],
    ["unlimited monthly", unlimited],
    ["inactive unlimited", { ...unlimited, status: "inactive", availableBytes: 0, includedAvailableBytes: 0 }],
    ["prepaid transfer", monthlyCloudBilling().entitlement.capacity!.network],
    ["PAYG transfer", { ...transfer, included: false, includedBytes: 0, includedAvailableBytes: 0 }],
  ])("accepts %s transfer through the SDK and public billing response", async (_label, network) => {
    const capacity = await readTransfer(network);
    expect(capacity.network).toMatchObject({ included: network.included, availableBytes: network.availableBytes });
    expect(Value.Check(BillingComputeSchema, {
      ...capacity, covered: capacity.computeCovered,
      currentPeriod: { start: capacity.periodStart, end: capacity.periodEnd },
    })).toBe(true);
  });

  it("preserves provider allowance and current-period usage without exposing owner wallet settings", async () => {
    const { network } = await readTransfer(transfer);
    expect(network).toMatchObject({ unlimited: false, status: "active", includedBytes: transfer.includedBytes,
      includedAvailableBytes: transfer.includedAvailableBytes, purchasedAvailableBytes: transfer.purchasedAvailableBytes,
      periodConsumedBytes: transfer.periodConsumedBytes, consumedBytes: transfer.consumedBytes });
    expect(network).not.toHaveProperty("wallet");
    expect(network).not.toHaveProperty("settings");
  });

  it.each(["active", "low", "grace", "blocked", "inactive"])("retains the provider's %s transfer state independently from compute coverage", async status => {
    const capacity = await readTransfer({ ...transfer, status, availableBytes: 0 });
    expect(capacity.computeCovered).toBe(true);
    expect(capacity.network).toMatchObject({ status, availableBytes: 0 });
  });

  it("does not turn an unlimited transfer benefit into paid compute coverage", async () => {
    expect((await readTransfer({ ...unlimited, status: "inactive", availableBytes: 0, includedAvailableBytes: 0 }, false))
      .computeCovered).toBe(false);
  });

  it.each(["includedBytes", "includedAvailableBytes", "availableBytes"])("requires explicit unlimited for null %s", async field => {
    for (const unlimited of [undefined, false]) {
      await expect(readTransfer({ ...transfer, unlimited, [field]: null }))
        .rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
    }
  });

  it.each([
    { included: "true" }, { unlimited: "true" }, { periodConsumedBytes: -1 },
    { availableBytes: -1 }, { includedBytes: "unlimited" }, { status: "made-up" },
  ])("still rejects malformed transfer fields (%j)", async patch => {
    await expect(readTransfer({ ...transfer, ...patch }))
      .rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
  });
});
