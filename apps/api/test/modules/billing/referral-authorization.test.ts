import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const provider = vi.hoisted(() => ({ enabled: true, request: vi.fn() }));
vi.mock("@repo/platform/engine/config/env", async (original) => {
  const actual = await original<typeof import("@repo/platform/engine/config/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      CLOUD_MODE: true,
      get REFERRALS_ENABLED() {
        return provider.enabled;
      },
      REFERRAL_NAMESPACE: "openship",
    },
  };
});
// Only the external provider is substituted. HTTP authentication, native
// authorization, account storage and referral operations all use real code.
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienBillingApi: () => ({ referralRequest: provider.request }),
}));

import { db, schema, repos, seedOwner, type SeededOwner } from "../jobs/_harness";
import { eq } from "@repo/db";
import { mintPatToken, hashPatToken } from "@repo/platform/engine/lib/pat";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import {
  referralParticipantKey,
  unavailableReferralOverview,
} from "@repo/platform/engine/modules/referrals/referral-provider";
import { OpenshipClient } from "@repo/sdk/client";
import { createShip } from "@repo/sdk/native";
import { referralProgramRoutes } from "../../../src/modules/referrals/referral-program.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/referral-program", referralProgramRoutes);
const remote = (owner: SeededOwner, token = owner.token) =>
  new OpenshipClient({
    baseUrl: "http://openship.test",
    token,
    organizationId: owner.orgId,
    fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
  }).referralProgram;
const payout = { amountCents: 5000, idempotencyKey: "referral-review-request" };

beforeEach(() => {
  provider.enabled = true;
  provider.request.mockImplementation(async (_method, _path, scope) => ({
    success: true,
    scope: { namespace: scope.namespace, participantKey: scope.participantKey },
    data: unavailableReferralOverview(),
  }));
});
afterEach(() => vi.clearAllMocks());

describe("referral identity through real HTTP, native authorization and storage", () => {
  it("derives distinct participants from authenticated accounts in both transports", async () => {
    const alice = await seedOwner({ bound: false }),
      bob = await seedOwner({ bound: false });
    await remote(alice).overview();
    await remote(bob).overview();
    const user = (await repos.user.findById(alice.userId))!;
    const ship = createShip({
      platform: getPlatformKernel(),
      identity: { resolve: async () => ({ user, sessionId: "test-native" }) },
    });
    const native = await ship.scope({ identity: "verified", organizationId: alice.orgId });
    await native.referralProgram.overview();
    expect(provider.request.mock.calls.map(([, , scope]) => scope)).toEqual([
      { namespace: "openship", participantKey: referralParticipantKey(alice.userId) },
      { namespace: "openship", participantKey: referralParticipantKey(bob.userId) },
      { namespace: "openship", participantKey: referralParticipantKey(alice.userId) },
    ]);
  });

  it("rejects real organization-bound, scoped and read-only write credentials before provider access", async () => {
    const bound = await seedOwner();
    await expect(remote(bound).overview()).rejects.toMatchObject({
      code: "AFFILIATE_ACCOUNT_REQUIRED",
    });
    const owner = await seedOwner({ bound: false });
    for (const scoped of [false, true]) {
      const token = mintPatToken();
      await repos.personalAccessToken.create({
        userId: owner.userId,
        organizationId: scoped ? owner.orgId : null,
        name: "Referral authorization check",
        tokenPrefix: token.tokenPrefix,
        tokenHash: token.tokenHash,
        readOnly: !scoped,
        scoped,
        expiresAt: null,
      });
      if (scoped)
        await expect(remote(owner, token.token).overview()).rejects.toMatchObject({
          code: "AFFILIATE_ACCOUNT_REQUIRED",
        });
      else
        await expect(remote(owner, token.token).requestPayout(payout)).rejects.toMatchObject({
          code: "TOKEN_READ_ONLY",
        });
    }
    expect(provider.request).not.toHaveBeenCalled();
  });

  it("does not accept forged beneficiaries or expose payout approval and destination reveal over customer HTTP", async () => {
    const owner = await seedOwner({ bound: false });
    for (const body of [
      { ...payout, participantKey: "b".repeat(64) },
      { ...payout, namespace: "other" },
      { ...payout, status: "paid" },
    ]) {
      const response = await app.request("/api/referral-program/payouts", {
        method: "POST",
        headers: { ...owner.auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    for (const path of ["payouts/queue", "payouts/review", "payouts/destination"]) {
      const response = await app.request(`/api/referral-program/${path}`, { headers: owner.auth });
      expect(response.status).toBe(404);
    }
    expect(provider.request).not.toHaveBeenCalled();
  });

  it("rechecks revoked access tokens and native memberships instead of reusing prior authority", async () => {
    const owner = await seedOwner({ bound: false });
    const client = remote(owner);
    await client.overview();
    const token = (await repos.personalAccessToken.findActiveByHash(hashPatToken(owner.token)))!;
    await repos.personalAccessToken.revoke(token.id, owner.userId);
    await expect(client.overview()).rejects.toMatchObject({ status: 401 });
    const user = (await repos.user.findById(owner.userId))!;
    const ship = createShip({
      platform: getPlatformKernel(),
      identity: { resolve: async () => ({ user, sessionId: "test-native" }) },
    });
    const native = await ship.scope({ identity: "verified", organizationId: owner.orgId });
    await db.delete(schema.member).where(eq(schema.member.userId, owner.userId));
    await expect(native.referralProgram.overview()).rejects.toThrow();
    expect(provider.request).toHaveBeenCalledTimes(1);
  });

  it("keeps the disabled program unavailable without calling the provider or accepting payout requests", async () => {
    const owner = await seedOwner({ bound: false });
    provider.enabled = false;
    expect((await remote(owner).overview()).available).toBe(false);
    await expect(remote(owner).requestPayout(payout)).rejects.toMatchObject({
      code: "AFFILIATES_UNAVAILABLE",
    });
    expect(provider.request).not.toHaveBeenCalled();
  });
});
