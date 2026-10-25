import { describe, it, expect, vi } from "vitest";
import { createAffiliateOperations } from "../src/affiliates";
import type { Authorization } from "../src/authorization";
import { freezeContext } from "../src/context";
import {
  callAffiliateProvider,
  affiliateParticipantKey,
  unavailableAffiliateOverview,
} from "../src/engine/modules/affiliates/affiliate-provider";
import { affiliateCheckoutBinding } from "../src/engine/modules/affiliates/affiliate-checkout";
import {
  runAffiliateOperator,
  readAffiliatePayoutQueue,
} from "../src/engine/modules/affiliates/affiliate.operator";
import { CreateSubscriptionBody, CreateTopupBody, parseInput } from "@repo/contracts";

const id = "18f9eda9-6310-4440-a115-7907da5c485b";
const ctx = freezeContext({
  userId: "alice",
  user: { id: "alice", email: "alice@example.test", name: null },
  organizationId: "team",
  sessionId: "session",
  sessionKind: "cookie",
  membershipId: "member",
  role: "member",
  clientIp: null,
  userAgent: null,
  traceId: "trace",
});
const scope = { namespace: "openship", participantKey: affiliateParticipantKey("alice") };
const envelope = (data: unknown) => ({ success: true, scope, data });

describe("personal affiliate authority", () => {
  const setup = () => {
    const overview = vi.fn(async () => unavailableAffiliateOverview());
    const enroll = vi.fn(async () => unavailableAffiliateOverview());
    const resolveScope = vi.fn(async () => ctx);
    const authorization = {
      authorize: vi.fn(),
      resolveScope,
      checkPermission: vi.fn(),
      checkPermissionOnResource: vi.fn(),
    } as Authorization;
    return {
      overview,
      enroll,
      resolveScope,
      operations: createAffiliateOperations(authorization, {
        collection: { overview, enroll } as never,
      }),
    };
  };
  it("uses the authenticated person even when they are only a team member", async () => {
    const h = setup();
    await h.operations.overview(ctx);
    expect(h.overview).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "alice", organizationId: "team", role: "member" }),
      undefined,
    );
    h.resolveScope.mockRejectedValueOnce(new Error("Membership revoked"));
    await expect(h.operations.overview(ctx)).rejects.toThrow("Membership revoked");
    expect(h.overview).toHaveBeenCalledTimes(1);
  });
  it("rejects project and organization credentials and read-only writes", async () => {
    const h = setup();
    for (const patch of [
      { tokenScope: { tokenId: "project" } },
      { credential: { organizationId: "team", readOnly: false } },
    ])
      await expect(h.operations.overview({ ...ctx, ...patch })).rejects.toMatchObject({
        code: "AFFILIATE_ACCOUNT_REQUIRED",
      });
    await expect(
      h.operations.enroll({ ...ctx, credential: { organizationId: null, readOnly: true } }),
    ).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    expect(h.overview).not.toHaveBeenCalled();
    expect(h.enroll).not.toHaveBeenCalled();
  });
});

describe("provider boundary", () => {
  it("binds every operation and rejects another participant or namespace", async () => {
    const billing = {
      affiliateRequest: vi.fn(async () => envelope(unavailableAffiliateOverview())),
    };
    const result = await callAffiliateProvider(
      billing,
      scope,
      "https://app.openship.test",
      "overview",
    );
    expect(result.available).toBe(true);
    expect(billing.affiliateRequest).toHaveBeenCalledWith(
      "GET",
      "/billing/affiliates/reseller/overview",
      scope,
    );
    for (const changed of [
      { ...scope, namespace: "other" },
      { ...scope, participantKey: affiliateParticipantKey("bob") },
    ]) {
      billing.affiliateRequest.mockResolvedValueOnce({
        ...envelope(unavailableAffiliateOverview()),
        scope: changed,
      });
      await expect(
        callAffiliateProvider(billing, scope, "https://app.openship.test", "overview"),
      ).rejects.toMatchObject({ code: "AFFILIATE_PROVIDER_SCOPE_MISMATCH" });
    }
  });
  it("projects commercial links without exposing provider wallet or beneficiary data", async () => {
    const billing = {
      affiliateRequest: vi.fn(async () =>
        envelope({
          id,
          code: "AF-0123456789",
          url: "https://evil.test",
          name: "Share",
          productId: "workspace_vm",
          planId: null,
          commissionBps: 2000,
          discountBps: 500,
          durationMonths: 12,
          status: "active",
          createdAt: new Date().toISOString(),
          expiresAt: null,
          revokedAt: null,
          user_id: "provider-secret",
          participant_key: "private",
          wallet: 1000000,
        }),
      ),
    };
    const result = await callAffiliateProvider(
      billing,
      scope,
      "https://app.openship.test",
      "createOffer",
      { policyId: id, name: "Share", discountBps: 500, idempotencyKey: "1234567890123456" },
    );
    expect(result.url).toBe("https://app.openship.test/r/AF-0123456789");
    expect(result).not.toHaveProperty("user_id");
    expect(result).not.toHaveProperty("wallet");
    expect(result).not.toHaveProperty("participant_key");
  });
  it("fails closed on incomplete monetary totals", async () => {
    await expect(
      callAffiliateProvider(
        { affiliateRequest: async () => envelope({ summary: { available: 10000 } }) },
        scope,
        "https://app.openship.test",
        "overview",
      ),
    ).rejects.toMatchObject({ code: "AFFILIATE_PROVIDER_RESPONSE_INVALID" });
  });
});

describe("ordinary checkout attribution", () => {
  const input = {
    enabled: true,
    namespace: "openship",
    userId: "buyer",
    memberIds: ["owner", "buyer"],
    offer: { billingMode: "monthly", unitAmount: 12000 },
    interval: "annual" as const,
    affiliateCode: "AF-0123456789",
  };
  it("stores verified buyer and workspace identities for monthly and annual compute", () => {
    expect(affiliateCheckoutBinding(input)).toEqual({
      affiliateCode: input.affiliateCode,
      affiliateBuyer: {
        namespace: "openship",
        buyerKey: affiliateParticipantKey("buyer"),
        relatedKeys: [affiliateParticipantKey("owner"), affiliateParticipantKey("buyer")],
      },
    });
    expect(
      affiliateCheckoutBinding({
        ...input,
        interval: "monthly",
        offer: { ...input.offer, unitAmount: 1000 },
      }),
    ).toHaveProperty("affiliateBuyer");
  });
  it("keeps Manage, PAYG, disabled programs and cheaper compute ineligible without changing normal checkout", () => {
    for (const patch of [
      { enabled: false },
      { offer: { billingMode: "service", unitAmount: 2000 } },
      { offer: { billingMode: "payg", unitAmount: 5000 } },
      { offer: { billingMode: "monthly", unitAmount: 11999 } },
    ]) {
      expect(() => affiliateCheckoutBinding({ ...input, ...patch })).toThrow();
      expect(affiliateCheckoutBinding({ ...input, ...patch, affiliateCode: undefined })).toEqual(
        {},
      );
    }
  });
  it("never accepts buyer identity or commercial rules through the public purchase contract", () => {
    const purchase = {
      planTierId: "hobby",
      interval: "annual",
      affiliateCode: input.affiliateCode,
    };
    expect(parseInput(CreateSubscriptionBody, purchase)).toEqual(purchase);
    for (const field of ["affiliateBuyer", "participantKey", "commissionBps", "discountBps"])
      expect(() =>
        parseInput(CreateSubscriptionBody, { ...purchase, [field]: "forged" }),
      ).toThrow();
    expect(() =>
      parseInput(CreateTopupBody, { packId: "extra", affiliateCode: input.affiliateCode }),
    ).toThrow();
  });
});

it("operator controls require a reason and bind the target by server-resolved user identity", async () => {
  const billing = {
    affiliateRequest: vi.fn(async () => envelope({ enabled: true, payoutMinimumCents: 5000 })),
  };
  const target = {
    userId: "alice",
    namespace: "openship",
    dashboardUrl: "https://app.openship.test",
  };
  await expect(
    runAffiliateOperator({ command: "configure", minimumCents: 1, enabled: true }, target, billing),
  ).rejects.toThrow();
  expect(billing.affiliateRequest).not.toHaveBeenCalled();
  await runAffiliateOperator(
    {
      command: "configure",
      minimumCents: 5000,
      enabled: true,
      operator: "finance",
      reason: "Approved",
    },
    target,
    billing,
  );
  expect(billing.affiliateRequest).toHaveBeenCalledWith(
    "POST",
    "/billing/affiliates/reseller/participant",
    {
      ...scope,
      input: { payoutMinimumCents: 5000, enabled: true, operator: "finance", reason: "Approved" },
    },
  );
});

describe("trusted payout review", () => {
  const row = {
    id,
    participantKey: scope.participantKey,
    amountCents: 5000,
    currency: "usd",
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    paymentReference: null,
    reviewedBy: null,
    reviewReason: null,
  };
  it("reads a bounded program queue, validating scope and financial records", async () => {
    const data = { items: [row], total: 1 };
    const billing = {
      affiliateRequest: vi.fn(async () => ({
        success: true,
        scope: { namespace: "openship" },
        data,
      })),
    };
    expect(await readAffiliatePayoutQueue({}, "openship", billing)).toEqual(data);
    expect(billing.affiliateRequest).toHaveBeenCalledExactlyOnceWith(
      "GET",
      "/billing/affiliates/reseller/payouts/queue",
      {
        namespace: "openship",
        status: "pending",
        limit: 25,
        offset: 0,
      },
    );
    billing.affiliateRequest.mockResolvedValueOnce({
      success: true,
      scope: { namespace: "mindwire" },
      data,
    });
    await expect(readAffiliatePayoutQueue({}, "openship", billing)).rejects.toMatchObject({
      code: "AFFILIATE_PROVIDER_SCOPE_MISMATCH",
    });
    billing.affiliateRequest.mockResolvedValueOnce({
      success: true,
      scope: { namespace: "openship" },
      data: {
        items: [{ ...row, amountCents: -1 }],
        total: 1,
      },
    });
    await expect(readAffiliatePayoutQueue({}, "openship", billing)).rejects.toMatchObject({
      code: "AFFILIATE_PROVIDER_RESPONSE_INVALID",
    });
  });
  it("rejects unbounded or forged queue selectors before provider access", async () => {
    const billing = { affiliateRequest: vi.fn() };
    for (const input of [
      { limit: 101 },
      { offset: -1 },
      { status: "all" },
      { participantKey: "forged" },
      { namespace: "another" },
    ])
      await expect(readAffiliatePayoutQueue(input, "openship", billing)).rejects.toThrow();
    expect(billing.affiliateRequest).not.toHaveBeenCalled();
  });
  it("can reconcile a deleted account by its participant key without accepting ambiguous targets", async () => {
    const command = {
      command: "paid",
      payoutId: id,
      paymentReference: "bank-transfer-recorded",
      operator: "finance",
      reason: "Transfer completed before account deletion",
    };
    const target = {
      namespace: "openship",
      dashboardUrl: "https://app.openship.test",
      participantKey: scope.participantKey,
    };
    const billing = { affiliateRequest: vi.fn(async () => envelope({ ...row, status: "paid" })) };
    await runAffiliateOperator(command, target, billing);
    expect(billing.affiliateRequest).toHaveBeenCalledWith(
      "POST",
      `/billing/affiliates/reseller/payouts/${id}/review`,
      {
        ...scope,
        input: {
          status: "paid",
          paymentReference: command.paymentReference,
          operator: "finance",
          reason: command.reason,
        },
      },
    );
    billing.affiliateRequest.mockClear();
    for (const changed of [
      { ...target, userId: "alice" },
      { ...target, participantKey: undefined },
      { ...target, participantKey: "../other" },
    ])
      await expect(runAffiliateOperator(command, changed, billing)).rejects.toThrow();
    expect(billing.affiliateRequest).not.toHaveBeenCalled();
  });
});
