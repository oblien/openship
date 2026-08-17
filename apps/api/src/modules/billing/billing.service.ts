/**
 * Billing service — Stripe outbound API (checkout, portal) for cloud pricing.
 *
 * The inbound webhook side lives in `billing.webhooks.ts`; the DB-only
 * ledger lives in `billing.repository.ts`. This module is the thin
 * adapter between controllers and Stripe's REST surface.
 *
 * Self-hosted instances never load this — billing routes are mounted
 * only under CLOUD_MODE (see `billing.routes.ts`).
 */

import {
  AppError,
  PLANS,
  CREDIT_PACKS,
  activeCampaign,
  activeCampaigns,
  creditPack,
  resolveCampaignCouponId,
  resolveStripePriceId,
  resolveCreditPackPriceId,
  safeErrorMessage,
  type PlanTierId,
} from "@repo/core";
import { db, schema, eq, asc, desc } from "@repo/db";
import { runtimeTarget, env } from "../../config/env";
import type { RequestContext } from "../../lib/request-context";
import { stripe } from "../../lib/stripe-client";
import { handleStripeEvent as handleStripeWebhook } from "./billing.webhooks";
import * as billingRepository from "./billing.repository";

/* ---------- Feature gate (master switch, cloud-owned) ---------- */

/**
 * The ONE server-side gate for "is the billing feature live". Every
 * Stripe-mutating path funnels through here so billing can be turned on by
 * flipping `BILLING_ENABLED` on the SaaS — with no dashboard or self-hosted
 * release. Fails CLOSED (403) when off, so a stale/racing client that still
 * shows a buy button can't start a real Stripe session. Read paths (state,
 * usage, plans) deliberately do NOT call this — the dashboard still renders the
 * "coming soon" surface and live usage/capacity while billing is disabled.
 */
export function assertBillingEnabled(): void {
  if (!env.BILLING_ENABLED) {
    throw new AppError(
      "Billing is not enabled yet. It's coming soon to Openship Cloud.",
      403,
      "BILLING_NOT_ENABLED",
    );
  }
}

/** Top-ups gate — requires the master billing switch AND the top-ups sub-switch. */
export function assertTopupsEnabled(): void {
  assertBillingEnabled();
  if (!env.BILLING_TOPUPS_ENABLED) {
    throw new AppError(
      "One-time credit top-ups are not available yet.",
      403,
      "BILLING_TOPUPS_NOT_ENABLED",
    );
  }
}

/* ---------- Idempotency key helpers ---------- */

/**
 * Per-minute idempotency bucket for Stripe mutations the caller may
 * retry on transient failures (network, our own 5xx). Within a one-
 * minute window, retries collapse onto the same Stripe object; after
 * the window, callers get a fresh idempotency key — appropriate for
 * "user double-clicked Upgrade" but not for "Stripe replayed a
 * webhook three days later" (those are guarded by other tables).
 *
 * Format: `<flow>:<orgId>:<resource>:<yyyymmddhhmm>` so the key is
 * stable for retries inside the window AND visible to operators in
 * the Stripe dashboard's idempotency log.
 */
function minuteBucket(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const mi = String(now.getUTCMinutes()).padStart(2, "0");
  return `${y}${m}${d}${h}${mi}`;
}

function flowKey(flow: string, orgId: string, resource: string): string {
  return `${flow}:${orgId}:${resource}:${minuteBucket()}`;
}

/* ---------- Customer resolution ---------- */

/**
 * Resolve the Stripe customer id for an org, creating one if needed.
 *
 * The DB row is a cache; subsequent checkout/portal flows skip the
 * network round-trip. Idempotent against concurrent first-time
 * checkouts: `customers.create` is sent with `idempotencyKey =
 * "customer:<orgId>"`, so two requests in the TOCTOU window between
 * `getCustomerByOrg` and `customers.create` collapse into ONE Stripe
 * customer instead of minting duplicates. The org gets exactly one
 * Stripe customer for its lifetime, hence no time bucket on this key.
 *
 * The webhook handler treats Stripe as the source of truth and
 * overwrites the cache, so a manual deletion of the row self-heals
 * on the next event.
 */
async function getOrCreateStripeCustomerId(
  organizationId: string,
  email: string | undefined,
): Promise<string> {
  const existing = await billingRepository.getCustomerByOrg(organizationId);
  if (existing) return existing.stripeCustomerId;

  const customer = await stripe().customers.create(
    {
      email,
      metadata: { organizationId },
    },
    // Stable per-org key — org gets exactly ONE Stripe customer over its
    // lifetime, no time bucket. Concurrent first-time checkouts collapse
    // onto a single Stripe.Customer instead of minting duplicates.
    { idempotencyKey: `customer:${organizationId}` },
  );
  await billingRepository.upsertCustomer({
    orgId: organizationId,
    stripeCustomerId: customer.id,
    email: email ?? "",
  });
  return customer.id;
}

/**
 * Swap a live subscription onto a different price, prorated.
 *
 * `items: [{ id, price }]` REPLACES the existing item rather than adding one — the
 * item id is what makes it a swap; omitting it would leave the customer paying
 * for both tiers on one subscription. `proration_behavior:
 * "create_prorations"` is Stripe's default for a price change but is stated
 * explicitly here because the alternative (`none`) would silently give away the
 * upgrade for the rest of the period.
 *
 * The local row is NOT written here: `customer.subscription.updated` is the single
 * writer for tier state, and it already handles the price change (including
 * re-arming the Oblien quota). Writing here too would race it.
 */
async function changeSubscriptionPrice(
  stripeSubscriptionId: string,
  newPriceId: string,
  organizationId: string,
): Promise<void> {
  const sub = await stripe().subscriptions.retrieve(stripeSubscriptionId);
  const currentItem = sub.items?.data?.[0];
  if (!currentItem) {
    throw new AppError(
      "Subscription has no billable item to change",
      409,
      "BILLING_SUBSCRIPTION_MALFORMED",
    );
  }

  await stripe().subscriptions.update(
    stripeSubscriptionId,
    {
      items: [{ id: currentItem.id, price: newPriceId }],
      proration_behavior: "create_prorations",
      metadata: { ...(sub.metadata ?? {}), organizationId },
    },
    {
      idempotencyKey: flowKey("sub-change-price", organizationId, `${stripeSubscriptionId}-${newPriceId}`),
    },
  );
}

/* ---------- Campaign verification ---------- */

/**
 * Assert every live campaign's Stripe coupon actually matches what we advertise.
 *
 * The catalog's `percentOff` is DISPLAY; the coupon's `percent_off` is MONEY.
 * Nothing structural keeps them equal, so a catalog saying 50% against a coupon
 * set to 40% would bill the difference silently — precisely the "a number nothing
 * enforces" failure the pricing model is meant to exclude.
 *
 * Also checks the coupon is still valid and that its `redeem_by` (if set) does not
 * land BEFORE the advertised `endsAt`: a coupon expiring first means the page
 * offers a discount Stripe refuses. Discrepancies are returned, not thrown — the
 * caller (boot) logs them, because refusing to boot over a coupon typo would
 * trade a wrong price for an outage.
 */
export async function verifyCampaigns(): Promise<string[]> {
  const problems: string[] = [];
  const live = activeCampaigns(new Date());
  if (live.length === 0) return problems;

  for (const campaign of live) {
    const couponId = resolveCampaignCouponId(campaign);
    if (!couponId) {
      problems.push(`campaign "${campaign.id}" is live but ${campaign.stripeCouponEnv} is unset — customers are being shown a discount they will not receive`);
      continue;
    }
    try {
      const coupon = await stripe().coupons.retrieve(couponId);
      if (coupon.percent_off !== campaign.percentOff) {
        problems.push(`campaign "${campaign.id}" advertises ${campaign.percentOff}% but coupon ${couponId} gives ${coupon.percent_off ?? "an amount"}`);
      }
      if (coupon.valid === false) {
        problems.push(`campaign "${campaign.id}" points at coupon ${couponId}, which Stripe reports as no longer valid`);
      }
      if (coupon.redeem_by && coupon.redeem_by * 1000 < Date.parse(campaign.endsAt)) {
        problems.push(`campaign "${campaign.id}" runs until ${campaign.endsAt} but coupon ${couponId} stops being redeemable before that`);
      }
    } catch (err) {
      problems.push(`campaign "${campaign.id}" coupon ${couponId} could not be read from Stripe: ${safeErrorMessage(err)}`);
    }
  }

  return problems;
}

/* ---------- Checkout: subscription ---------- */

/**
 * Recurring-subscription checkout for a tier upgrade.
 *
 * The Stripe price id is looked up from the static PLANS catalog via
 * `(planTierId, interval)`. Free + enterprise rows have null prices and
 * are rejected here — free is implicit (no checkout) and enterprise is
 * contract-sales.
 *
 * Metadata is attached at TWO levels: on the session itself (so
 * `checkout.session.completed` can attribute the event to the org) and
 * on the subscription (so subsequent `customer.subscription.*` events
 * carry the same attribution without re-reading the session).
 */
export async function createCheckoutSession(
  ctx: RequestContext,
  planTierId: PlanTierId,
  interval: "monthly" | "annual",
): Promise<{ checkoutUrl: string }> {
  assertBillingEnabled();
  const organizationId = ctx.organizationId;
  const email = ctx.user.email;
  const plan = PLANS[planTierId];

  // A tier with no published price is not for sale here: free needs no
  // checkout, enterprise is contract sales.
  if (plan.price[interval] === null) {
    throw new AppError(
      `Plan ${planTierId} (${interval}) has no Stripe price configured`,
      400,
      "BILLING_PLAN_NOT_PURCHASABLE",
    );
  }

  // A price IS published but the operator hasn't set its Stripe price id.
  // Boot validation shouts about this (`validatePlanPriceIds`), but a price
  // published to the catalog after boot would otherwise reach Stripe as
  // `undefined`, so fail closed with a 503 at the point of use too.
  const stripePriceId = resolveStripePriceId(planTierId, interval);
  if (!stripePriceId) {
    throw new AppError(
      "Billing is not configured for this plan tier",
      503,
      "BILLING_NOT_CONFIGURED",
    );
  }

  // ALREADY SUBSCRIBED → change the existing subscription in place, never open a
  // second Checkout Session.
  //
  // This is a money bug, not a tidiness one: a Starter customer clicking Pro used
  // to get a fresh Checkout Session, and nothing — not the DB (unique only on
  // stripe_subscription_id), not Stripe — stopped the second subscription landing
  // beside the first. The org's `plan_tier_id` was overwritten to the new tier so
  // the dashboard looked right while the customer was billed for BOTH, and
  // `cancelSubscription` cancels only the newest row, so the orphan billed
  // forever. Swapping the price item instead is also the correct UX: Stripe
  // prorates, the customer is charged the difference today, and the inbound
  // `customer.subscription.updated` handler already detects the price change and
  // re-arms the Oblien quota.
  const existing = await billingRepository.findChangeableSubscription(organizationId);
  if (existing) {
    if (existing.stripePriceId === stripePriceId) {
      throw new AppError(
        `Already subscribed to ${planTierId} (${interval})`,
        409,
        "BILLING_ALREADY_ON_PLAN",
      );
    }
    await changeSubscriptionPrice(existing.stripeSubscriptionId, stripePriceId, organizationId);
    // No checkout to send them to — the change is already live. The caller
    // redirects to the overview, where the webhook-updated tier will be shown.
    return { checkoutUrl: `${runtimeTarget.dashboard}/billing/overview?plan=changed` };
  }

  const customerId = await getOrCreateStripeCustomerId(organizationId, email);

  // A campaign discount is applied automatically — no code typed. Resolved at
  // REQUEST time so an expired campaign stops discounting without a redeploy.
  //
  // A live campaign whose coupon env var isn't set resolves to null and we charge
  // LIST price. That is the safe direction: the alternative is a session that
  // advertises a discount Stripe will not honour. It is logged loudly because the
  // page is meanwhile showing the discounted number.
  const campaign = activeCampaign(planTierId, new Date());
  const campaignCoupon = campaign ? resolveCampaignCouponId(campaign) : null;
  if (campaign && !campaignCoupon) {
    console.error(
      `[billing] campaign "${campaign.id}" is live but ${campaign.stripeCouponEnv} is unset — charging list price for ${planTierId}`,
    );
  }

  const session = await stripe().checkout.sessions.create(
    {
      mode: "subscription",
      customer: customerId,
      client_reference_id: organizationId,
      metadata: { organizationId, planTierId, interval },
      subscription_data: {
        metadata: { organizationId, planTierId, interval },
      },
      line_items: [{ price: stripePriceId, quantity: 1 }],
      // A live campaign discount OR a redeemable code field — never both.
      //
      // Stripe rejects a request carrying both `discounts` and
      // `allow_promotion_codes` ("You may only specify one of these
      // parameters"), and it rejects on the KEY being present, so
      // `allow_promotion_codes: false` fails too — the key must be absent. The
      // pinned types declare them as independent optional siblings, so a params
      // object with both compiles cleanly and fails only at runtime. Hence the
      // conditional spread: the two branches are mutually exclusive by
      // construction rather than by care.
      //
      // While a campaign runs the code box is therefore hidden, so a campaign
      // should be at least as generous as any code already in circulation
      // (`promo-code.ts list` before launching one).
      ...(campaignCoupon
        ? { discounts: [{ coupon: campaignCoupon }] }
        : { allow_promotion_codes: true }),
      success_url: `${runtimeTarget.dashboard}/billing/overview?checkout=success`,
      cancel_url: `${runtimeTarget.dashboard}/billing/plans?checkout=cancelled`,
    },
    {
      // The campaign is part of the key: without it, a customer who opened
      // checkout before a campaign started would be handed the cached
      // undiscounted session afterwards (and vice versa after one ends).
      idempotencyKey: flowKey(
        "checkout-sub",
        organizationId,
        `${planTierId}-${interval}-${campaignCoupon ? campaign!.id : "list"}`,
      ),
    },
  );

  if (!session.url) {
    throw new Error("Failed to create checkout session");
  }

  return { checkoutUrl: session.url };
}

/* ---------- Checkout: one-shot top-up ---------- */

/**
 * One-shot top-up checkout for a credit pack. `mode: "payment"` (not
 * "subscription") since a pack is a single purchase, not recurring.
 *
 * The pack row is validated against `CREDIT_PACKS` (the canonical
 * catalog) and surfaced via `stripePriceId`. The webhook handler uses
 * `metadata.packId` to dereference the same constant on the inbound
 * side and mint the topup grant.
 */
export async function createTopupCheckoutSession(
  ctx: RequestContext,
  packId: string,
): Promise<{ checkoutUrl: string }> {
  assertTopupsEnabled();
  const organizationId = ctx.organizationId;
  const email = ctx.user.email;
  const pack = creditPack(packId);
  if (!pack) {
    throw new AppError(
      `Unknown top-up pack: ${packId}`,
      404,
      "BILLING_PACK_NOT_FOUND",
    );
  }
  const packPriceId = resolveCreditPackPriceId(packId);
  if (!packPriceId) {
    throw new AppError(
      "Billing is not configured for this plan tier",
      503,
      "BILLING_NOT_CONFIGURED",
    );
  }

  const customerId = await getOrCreateStripeCustomerId(organizationId, email);

  const session = await stripe().checkout.sessions.create(
    {
      mode: "payment",
      customer: customerId,
      client_reference_id: organizationId,
      metadata: { organizationId, packId },
      payment_intent_data: {
        metadata: { organizationId, packId },
      },
      line_items: [{ price: packPriceId, quantity: 1 }],
      success_url: `${runtimeTarget.dashboard}/billing/overview?topup=success`,
      cancel_url: `${runtimeTarget.dashboard}/billing/overview?topup=cancelled`,
    },
    { idempotencyKey: flowKey("checkout-topup", organizationId, packId) },
  );

  if (!session.url) {
    throw new Error("Failed to create top-up checkout session");
  }

  return { checkoutUrl: session.url };
}

/* ---------- Portal ---------- */

/**
 * Stripe-hosted customer portal — Stripe owns the invoice list, the
 * payment-method UI, and the cancellation flow. We just hand them a
 * one-shot redirect URL bound to this org's customer.
 *
 * Orgs without a Stripe customer row haven't ever started a checkout —
 * the portal would 404, so reject up-front with a friendlier error.
 */
export async function createPortalSession(
  organizationId: string,
): Promise<{ portalUrl: string }> {
  assertBillingEnabled();
  const customer = await billingRepository.getCustomerByOrg(organizationId);
  if (!customer) {
    throw new AppError(
      "No billing account — start a checkout first",
      404,
      "BILLING_CUSTOMER_NOT_FOUND",
    );
  }

  const session = await stripe().billingPortal.sessions.create(
    {
      customer: customer.stripeCustomerId,
      return_url: `${runtimeTarget.dashboard}/billing/overview`,
    },
    { idempotencyKey: flowKey("portal", organizationId, "session") },
  );

  return { portalUrl: session.url };
}

/* ---------- Cancellation ---------- */

/**
 * Flip `cancel_at_period_end=true` on the org's Stripe subscription.
 * Stripe still charges through the end of the current period and fires
 * `customer.subscription.deleted` on rollover — the webhook downgrades
 * the local row + tier when that event lands.
 *
 * Returns the period end so the dashboard can render "Cancels on …"
 * without a follow-up read. The local subscription row is mirrored
 * immediately so a refresh right after this call shows the new state.
 */
export async function cancelSubscription(
  organizationId: string,
): Promise<{ cancelAt: Date | null }> {
  assertBillingEnabled();

  // EVERY live subscription, not just the newest. Cancelling only the newest left
  // an older one billing forever for any org that managed to acquire two (which a
  // paid→paid upgrade used to cause — see `createCheckoutSession`). Upgrades no
  // longer create duplicates, but orgs already in that state must still be able to
  // cancel their way out of it.
  const subs = await billingRepository.listLiveSubscriptions(organizationId);

  if (subs.length === 0) {
    throw new AppError(
      "No active subscription to cancel",
      404,
      "BILLING_SUBSCRIPTION_NOT_FOUND",
    );
  }

  let cancelAt: Date | null = null;

  for (const sub of subs) {
    const updated = await stripe().subscriptions.update(
      sub.stripeSubscriptionId,
      { cancel_at_period_end: true },
      {
        idempotencyKey: flowKey(
          "sub-cancel-at-period-end",
          organizationId,
          sub.stripeSubscriptionId,
        ),
      },
    );

    await billingRepository
      .upsertSubscription({
        organizationId,
        stripeSubscriptionId: sub.stripeSubscriptionId,
        stripePriceId: sub.stripePriceId,
        planTierId: sub.planTierId as PlanTierId,
        interval: sub.interval as "monthly" | "annual",
        status: updated.status,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: true,
      })
      .catch((err) =>
        console.warn(
          "[billing] local mirror of cancel-at-period-end failed:",
          safeErrorMessage(err),
        ),
      );

    // Report the LATEST period end — that is when the customer actually loses
    // access, and reporting an earlier one would understate what they paid for.
    if (!cancelAt || sub.currentPeriodEnd > cancelAt) cancelAt = sub.currentPeriodEnd;
  }

  return { cancelAt };
}

/* ---------- Credit packs (catalog) ---------- */

/**
 * Active top-up packs surfaced in the dashboard. Reads off the
 * `credit_pack` table — the synced state of the `CREDIT_PACKS` constant
 * after the boot syncer runs (`syncCreditPacksFromConstants`).
 * Inactive rows (packs removed from the catalog) are filtered out
 * server-side so the client never has to.
 */
export async function listActiveCreditPacks() {
  return db
    .select()
    .from(schema.creditPack)
    .where(eq(schema.creditPack.active, true))
    .orderBy(asc(schema.creditPack.sortOrder));
}

/* ---------- Webhook (re-export) ---------- */

/**
 * Stripe webhook entry point. Delegates to billing.webhooks for the
 * actual dispatch + per-event handlers. Re-exported here so the
 * controller's import path doesn't need to change.
 */
export const handleStripeEvent = handleStripeWebhook;
