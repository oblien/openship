/**
 * Stripe webhook event router for cloud billing.
 *
 * Single entry point — `handleStripeEvent(rawBody, signature)`:
 *
 *   1. Verifies the Stripe signature against STRIPE_WEBHOOK_SECRET. A
 *      malformed/forged payload throws before any DB or Oblien write.
 *   2. Opens a transaction and acquires `pg_try_advisory_xact_lock`
 *      keyed on hash(event.id). The lock is released automatically at
 *      commit/rollback — a concurrent delivery of the same event will
 *      fail to acquire and return silently (the in-flight worker owns
 *      the processing).
 *   3. Inside the lock, checks `stripe_webhook_event.processed_at` —
 *      if set, returns silently (already fully processed). Otherwise
 *      inserts the claim row (no conflict possible — the lock
 *      serializes us with any other writer for this event).
 *   4. Dispatches to a per-type handler. Each handler translates the
 *      event into Oblien quota calls (`setQuota` / `resetQuota` /
 *      `activate`) — Oblien is the single source of truth for credit
 *      allowance + consumption. Local DB writes are limited to the
 *      subscription mapping rows the dashboard / portal need.
 *   5. On success: stamps `processed_at` so the next delivery
 *      short-circuits at step 3 (and the lock release is moot).
 *   6. On throw: the transaction rolls back, removing the claim row
 *      AND releasing the lock so Stripe's redelivery can re-acquire
 *      and fully retry. Re-throws so Hono's onError returns 5xx
 *      (Stripe retries on any non-2xx for the first 3 days).
 *
 * Quota-as-allowance model:
 *   - Tier purchase / renewal → `setQuota({quotaLimit: tier.monthlyCredits})`
 *     overwrites the ceiling. Oblien preserves `quota_used` independently
 *     so swapping the ceiling mid-period is correct (clamps high or low).
 *   - Top-up pack → claim `stripe_topup_grant` THEN `setQuota`
 *     ({quotaLimit: current + pack.credits}). The claim row is what
 *     guarantees no double-credit on Stripe webhook retries.
 *   - Tier downgrade / cancellation → `setQuotaForTier(orgId, 'free')`.
 *     Oblien clamps any over-consumed amount against the new ceiling.
 *   - Recurring renewal (`invoice.paid`) → `resetQuota` zeroes `quota_used`,
 *     then `setQuota` confirms the tier ceiling for the new period. Both
 *     calls are idempotent.
 *
 * Self-hosted instances never instantiate this — billing.controller only
 * mounts the webhook route under CLOUD_MODE.
 */

import type Stripe from "stripe";
import {
  AppError,
  PLANS,
  PLAN_IDS,
  CREDIT_PACKS,
  resolveStripePriceId,
  safeErrorMessage,
  type PlanTierId,
} from "@repo/core";
import { db, schema, repos, eq, sql, hashStringToInt } from "@repo/db";
import { env } from "../../config/env";
import { sendMail } from "../../lib/mail";
import { resolveOrgOwner } from "../../lib/org-actor";
import { stripe } from "../../lib/stripe-client";
import {
  upsertSubscription,
  upsertCustomer,
} from "./billing.repository";
import {
  setQuotaForTier,
  addQuota,
  resetAndRegrant,
} from "./billing-oblien-quota";

/* ───────── Canonical subscription status enum ───────────────────────────── */

/**
 * Compact, downstream-safe status surfaced on org.subscription_status
 * AND billing_subscription.status. Replaces the raw Stripe enum, which
 * carries `trialing`, `incomplete`, `incomplete_expired`, `paused`, and
 * `unpaid` — values gating middleware doesn't know how to interpret.
 */
export type CanonicalSubscriptionStatus =
  | "active"
  | "past_due"
  | "canceled"
  | "credit_exhausted";

/**
 * Collapse a Stripe subscription status into the canonical enum used by
 * gating middleware. Trial-in-progress counts as `active` (the user has
 * a paid-tier ceiling), dunning failures route to `past_due`, terminal
 * states to `canceled`, and the awkward "subscription created but
 * payment not yet collected" states map to `past_due` (treat as
 * suspended-pending so middleware shows the same banner).
 *
 * Centralizing this mapping prevents drift: every status write in this
 * module routes through here.
 */
export function mapStripeStatusToCanonical(
  s: Stripe.Subscription.Status,
): CanonicalSubscriptionStatus {
  if (s === "active" || s === "trialing") return "active";
  if (s === "past_due" || s === "unpaid") return "past_due";
  if (s === "canceled" || s === "incomplete_expired") return "canceled";
  if (s === "incomplete" || s === "paused") return "past_due";
  return "canceled";
}


/* ───────── Event type allowlist ─────────────────────────────────────────── */

/**
 * Every event type wired to a concrete handler. Anything not in this set
 * is either rejected (5xx → Stripe retries) when financially relevant, or
 * silently accepted otherwise. The list mirrors the cases in the
 * dispatcher below — keep them in sync.
 */
export const HANDLED_EVENT_TYPES = new Set<string>([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.deleted",
]);

/**
 * Financial events. If a type lands here but is NOT in HANDLED_EVENT_TYPES
 * we throw a 501 so Stripe retries — silently 2xx-ing a stub would lose
 * subscription state forever. Operators must implement the handler or
 * explicitly opt out via BILLING_WEBHOOK_DISCARD_UNHANDLED=true.
 */
const FINANCIAL_EVENT_TYPES = new Set<string>([
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

/* ───────── Public entry point ───────────────────────────────────────────── */

/**
 * Stripe webhook handler. Verifies signature, deduplicates by event.id,
 * dispatches to the per-type handler.
 *
 * Throws on:
 *   - missing/invalid signature
 *   - financially-relevant event types without a handler
 *     (set BILLING_WEBHOOK_DISCARD_UNHANDLED=true to accept-and-drop)
 *   - downstream handler errors (so Stripe retries)
 *
 * Returns silently on:
 *   - duplicate delivery (PK conflict in stripe_webhook_event)
 *   - non-financial unhandled types
 */
export async function handleStripeEvent(
  rawBody: string,
  signature?: string,
): Promise<void> {
  if (!env.STRIPE_WEBHOOK_SECRET || !signature) {
    throw new Error("Webhook signature verification failed");
  }

  const event = stripe().webhooks.constructEvent(
    rawBody,
    signature,
    env.STRIPE_WEBHOOK_SECRET,
  );

  // pg_try_advisory_xact_lock serializes processing across replicas
  // WITHOUT requiring a separate "claim" row, eliminating the
  // INSERT-then-clear race that the previous two-phase shape suffered.
  // The lock is released at commit/rollback automatically — a crashed
  // handler frees the lock for the next delivery without operator
  // intervention.
  const lockKey = hashStringToInt(`stripe:event:${event.id}`);

  await db.transaction(async (tx) => {
    const lockResult = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${lockKey}) AS acquired`,
    );
    const acquired = readAcquired(lockResult);
    if (!acquired) {
      // Peer is processing this event; their commit will stamp
      // processed_at, so we return silently (Stripe gets 2xx).
      return;
    }

    // Same-id event already finalized by a prior delivery (we hold
    // the lock now, so no concurrent writer is touching this row).
    const [existing] = await tx
      .select({
        processedAt: schema.stripeWebhookEvent.processedAt,
      })
      .from(schema.stripeWebhookEvent)
      .where(eq(schema.stripeWebhookEvent.stripeEventId, event.id))
      .limit(1);
    if (existing?.processedAt) return;

    if (!HANDLED_EVENT_TYPES.has(event.type)) {
      if (FINANCIAL_EVENT_TYPES.has(event.type)) {
        if (process.env.BILLING_WEBHOOK_DISCARD_UNHANDLED === "true") {
          console.warn(
            `[billing] discarding unhandled financial event ${event.id} (${event.type}) — BILLING_WEBHOOK_DISCARD_UNHANDLED=true`,
          );
          await upsertWebhookEventProcessed(tx, event.id, event.type);
          return;
        }
        // Throwing inside the transaction rolls back any partial
        // writes AND releases the advisory lock — Stripe's redelivery
        // can fully retry.
        throw new AppError(
          `Billing webhook handler for ${event.type} is not implemented. Stripe will retry. ` +
            `Set BILLING_WEBHOOK_DISCARD_UNHANDLED=true to accept-and-drop in pre-launch environments.`,
          501,
          "BILLING_WEBHOOK_UNIMPLEMENTED",
        );
      }
      // Non-financial unhandled event (e.g. customer.created notification) — accept.
      await upsertWebhookEventProcessed(tx, event.id, event.type);
      return;
    }

    try {
      switch (event.type) {
        case "checkout.session.completed":
          await handleCheckoutSessionCompleted(
            event.data.object as Stripe.Checkout.Session,
          );
          break;
        case "customer.subscription.created":
          await handleSubscriptionCreated(
            event.data.object as Stripe.Subscription,
          );
          break;
        case "customer.subscription.updated":
          await handleSubscriptionUpdated(
            event.data.object as Stripe.Subscription,
          );
          break;
        case "customer.subscription.deleted":
          await handleSubscriptionDeleted(
            event.data.object as Stripe.Subscription,
          );
          break;
        case "invoice.paid":
          await handleInvoicePaid(event.data.object as Stripe.Invoice);
          break;
        case "invoice.payment_failed":
          await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
          break;
        case "customer.deleted":
          await handleCustomerDeleted(event.data.object as Stripe.Customer);
          break;
      }
      await upsertWebhookEventProcessed(tx, event.id, event.type);
    } catch (err) {
      console.error(
        `[billing] webhook handler failed for ${event.type} (${event.id}):`,
        safeErrorMessage(err),
      );
      // Re-throw — the surrounding transaction rolls back (including
      // the processed-stamp upsert and any in-handler writes that ran
      // inside this tx). Hono's onError returns 5xx and Stripe retries.
      throw err;
    }
  });
}

/**
 * Insert OR mark-processed the webhook event row. Stamps processed_at
 * so the next delivery of the same event short-circuits without re-
 * acquiring the advisory lock. Idempotent against a partially-written
 * prior attempt thanks to ON CONFLICT DO UPDATE.
 */
async function upsertWebhookEventProcessed(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  eventId: string,
  eventType: string,
): Promise<void> {
  await tx
    .insert(schema.stripeWebhookEvent)
    .values({
      stripeEventId: eventId,
      eventType,
      processedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.stripeWebhookEvent.stripeEventId,
      set: { processedAt: new Date() },
    });
}

/**
 * Defensive read of `pg_try_advisory_xact_lock`'s result. Drizzle's
 * `execute` wraps drivers (pg, pglite, neon) that differ on
 * `{ rows: [...] }` vs the raw array. Probe both shapes and coerce
 * to boolean — anything other than `true` is treated as not-acquired,
 * so a malformed driver response fails closed (no double-process).
 */
function readAcquired(result: unknown): boolean {
  const rows = Array.isArray(result)
    ? (result as Array<{ acquired?: unknown }>)
    : ((result as { rows?: Array<{ acquired?: unknown }> } | null)?.rows ?? []);
  const row = rows[0];
  return row?.acquired === true;
}

/* ───────── checkout.session.completed ───────────────────────────────────── */

/**
 * Branch on session.mode:
 *   - "subscription" → tier upgrade: upsert subscription mapping (which also
 *     bumps org.planTierId + subscription_status), then `setQuotaForTier`
 *     to overwrite the Oblien quota ceiling with the tier's monthlyCredits.
 *     If the org was credit_exhausted (Oblien suspended), `activate` lifts
 *     the gate so the new allowance is usable.
 *   - "payment"      → one-shot top-up: resolve pack by metadata.packId,
 *     `addQuota` reads the current Oblien ceiling and bumps it by the
 *     pack's credit amount. If suspended, activate.
 */
async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const orgId =
    session.metadata?.organizationId ??
    (session.client_reference_id || null);
  if (!orgId) {
    console.warn(
      `[billing] checkout.session.completed ${session.id} has no organizationId — skipping`,
    );
    return;
  }

  if (session.mode === "subscription") {
    const planTierId = (session.metadata?.planTierId ??
      session.metadata?.planId ??
      "free") as PlanTierId;
    const plan = PLANS[planTierId];
    if (!plan) {
      throw new AppError(
        `Unknown planTierId in checkout metadata: ${planTierId}`,
        400,
        "BILLING_UNKNOWN_PLAN",
      );
    }

    const stripeSubscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id ?? null;
    const stripeCustomerId =
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id ?? null;

    if (!stripeSubscriptionId || !stripeCustomerId) {
      throw new AppError(
        `checkout.session.completed missing subscription/customer ids (${session.id})`,
        400,
        "BILLING_INVALID_CHECKOUT_SESSION",
      );
    }

    // Pull the fresh subscription so we have authoritative period dates +
    // price_id (the session object's expansions vary by API version).
    const sub = await stripe().subscriptions.retrieve(stripeSubscriptionId);

    // Customer mapping table — keeps subsequent webhooks attributable when
    // they only carry customer_id (no metadata).
    await upsertCustomer({
      orgId,
      stripeCustomerId,
      email: session.customer_details?.email ?? session.customer_email ?? "",
    });

    await upsertSubscription({
      organizationId: orgId,
      stripeSubscriptionId,
      stripePriceId: resolvePriceIdFromSub(sub),
      planTierId,
      interval: resolveIntervalFromSub(sub),
      status: mapStripeStatusToCanonical(sub.status),
      currentPeriodStart: periodStart(sub),
      currentPeriodEnd: periodEnd(sub),
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    });

    // Mirror customer id onto the org row for fast lookup (organization
    // already gets planTierId + status from upsertSubscription).
    await db
      .update(schema.organization)
      .set({ stripeCustomerId })
      .where(eq(schema.organization.id, orgId));

    await setQuotaForTier(orgId, planTierId);
    return;
  }

  if (session.mode === "payment") {
    const packId = session.metadata?.packId;
    if (!packId) {
      throw new AppError(
        `payment-mode checkout ${session.id} missing metadata.packId`,
        400,
        "BILLING_MISSING_PACK_ID",
      );
    }
    const pack = CREDIT_PACKS.find((p) => p.id === packId);
    if (!pack) {
      throw new AppError(
        `Unknown credit pack: ${packId}`,
        400,
        "BILLING_UNKNOWN_PACK",
      );
    }

    // CRITICAL idempotency: `addQuota` is read-modify-write against
    // Oblien (current + delta). Stripe retries the same
    // checkout.session.completed event on any non-2xx and occasionally
    // even after a successful one. Without this claim, a retry would
    // re-add the pack on top of the already-credited ceiling —
    // double-crediting the org.
    //
    // The claim row (keyed unique on checkout_session_id) lands BEFORE
    // the Oblien call; a conflict means a prior delivery already
    // credited the session and we skip. This runs inside the same
    // transaction as the rest of the webhook dispatcher, so a thrown
    // addQuota also rolls back the claim — Stripe's redelivery gets a
    // clean retry.
    const claim = await repos.stripeTopupGrant.claim({
      checkoutSessionId: session.id,
      organizationId: orgId,
      packId: pack.id,
      creditsMilli: pack.credits_milli,
    });
    if (!claim.claimed) {
      console.log(
        `[stripe] topup grant already applied for session=${session.id} — skipping retry`,
      );
      return;
    }

    // Pack credits live in milli-credits — the same unit as
    // PLANS[].monthlyCredits. The quota wrapper (billing-oblien-quota.ts) owns
    // the single milli→Oblien-credit boundary (÷1000 + clamp) on the addQuota
    // write, so we forward the pack's credits_milli directly here.
    await addQuota(orgId, pack.credits_milli);
    return;
  }

  // Other modes (setup, etc.) — no financial mutation.
}

/* ───────── customer.subscription.created ────────────────────────────────── */

/**
 * Initial subscription record. checkout.session.completed normally lands
 * first and does the heavy lifting; this handler is a safety net for
 * direct-API-created subscriptions (admin tooling, migrations) and is
 * fully idempotent against the checkout flow via upsertSubscription's
 * ON CONFLICT DO UPDATE and Oblien's idempotent setQuota.
 */
async function handleSubscriptionCreated(sub: Stripe.Subscription): Promise<void> {
  const orgId = await resolveOrgFromSubscription(sub);
  if (!orgId) {
    console.warn(
      `[billing] subscription.created ${sub.id} unattributable — skipping`,
    );
    return;
  }
  const planTierId = resolvePlanFromPriceId(sub);

  await upsertSubscription({
    organizationId: orgId,
    stripeSubscriptionId: sub.id,
    stripePriceId: resolvePriceIdFromSub(sub),
    planTierId,
    interval: resolveIntervalFromSub(sub),
    status: mapStripeStatusToCanonical(sub.status),
    currentPeriodStart: periodStart(sub),
    currentPeriodEnd: periodEnd(sub),
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
  });

  await setQuotaForTier(orgId, planTierId);
}

/* ───────── customer.subscription.updated ────────────────────────────────── */

/**
 * Three distinct flows on this one webhook:
 *   1. Price changed → tier change. Overwrite the Oblien quota ceiling
 *      with the new tier's monthlyCredits via `setQuotaForTier`. No manual
 *      proration: Oblien preserves `quota_used` independently per
 *      (namespace, service) so swapping the ceiling mid-period is correct
 *      whether the new tier is higher (more room) or lower (clamped down).
 *   2. cancel_at_period_end flipped → mirror onto the local subscription
 *      row so the dashboard reflects the pending cancellation. No quota
 *      call — the user still has the period they paid for.
 *   3. Dunning recovery (`past_due` → `active`): the user's card finally
 *      cleared. We MUST re-apply the tier ceiling — without it the org
 *      stays stuck in past_due forever because `setQuotaForTier` only
 *      fires on price change above. This is the same call the tier-change
 *      path runs, gated separately so the audit reason is explicit.
 */
async function handleSubscriptionUpdated(sub: Stripe.Subscription): Promise<void> {
  const orgId = await resolveOrgFromSubscription(sub);
  if (!orgId) {
    console.warn(
      `[billing] subscription.updated ${sub.id} unattributable — skipping`,
    );
    return;
  }

  const newPlanTierId = resolvePlanFromPriceId(sub);

  // Pull the previous local row to detect price flip vs cancel_at flip
  // AND a past_due → active recovery transition.
  const [prev] = await db
    .select()
    .from(schema.billingSubscription)
    .where(eq(schema.billingSubscription.stripeSubscriptionId, sub.id))
    .limit(1);

  const newPriceId = resolvePriceIdFromSub(sub);
  const priceChanged = !!prev && prev.stripePriceId !== newPriceId;
  const newStatus = mapStripeStatusToCanonical(sub.status);
  // Dunning recovery: prior local row was `past_due` and Stripe is now
  // reporting active/trialing. The local subscription_status flip needs a
  // paired quota refresh (setQuotaForTier) so the tier ceiling is re-asserted
  // after recovery. Oblien owns any workspace stop/start via its overdraft
  // gate — we don't suspend/activate on this path.
  const recoveredFromPastDue =
    !!prev && prev.status === "past_due" && newStatus === "active";

  await upsertSubscription({
    organizationId: orgId,
    stripeSubscriptionId: sub.id,
    stripePriceId: newPriceId,
    planTierId: newPlanTierId,
    interval: resolveIntervalFromSub(sub),
    status: newStatus,
    currentPeriodStart: periodStart(sub),
    currentPeriodEnd: periodEnd(sub),
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
  });

  if (priceChanged || recoveredFromPastDue) {
    // Tier change OR dunning recovery: re-arm the Oblien ceiling. Oblien
    // preserves quota_used, so a single setQuota with the (possibly
    // unchanged) tier ceiling is correct — no proration, no delta.
    await setQuotaForTier(orgId, newPlanTierId);
  }
  // cancel_at_period_end change is already mirrored by upsertSubscription;
  // no Oblien call needed — the current period's allowance stands.
}

/* ───────── customer.subscription.deleted ────────────────────────────────── */

/**
 * Subscription fully ended (cancellation reached period_end, or hard-deleted).
 * Downgrade org to free and set the Free tier ceiling. Oblien preserves
 * the existing quota_used count — if the user over-consumed before the
 * downgrade, the new (lower) ceiling will naturally enforce that.
 *
 * No need to "expire" credits — Oblien holds the consumption count, not a
 * minted-credit ledger. There's nothing to clear.
 */
async function handleSubscriptionDeleted(sub: Stripe.Subscription): Promise<void> {
  const orgId = await resolveOrgFromSubscription(sub);
  if (!orgId) {
    console.warn(
      `[billing] subscription.deleted ${sub.id} unattributable — skipping`,
    );
    return;
  }

  await upsertSubscription({
    organizationId: orgId,
    stripeSubscriptionId: sub.id,
    stripePriceId: resolvePriceIdFromSub(sub),
    planTierId: "free",
    interval: resolveIntervalFromSub(sub),
    status: "canceled",
    currentPeriodStart: periodStart(sub),
    currentPeriodEnd: periodEnd(sub),
    cancelAtPeriodEnd: false,
  });

  await setQuotaForTier(orgId, "free");
  // Status already "canceled" — no canonical mapping needed; this is
  // the terminal flush path.
}

/* ───────── invoice.paid ─────────────────────────────────────────────────── */

/**
 * Period anniversary for a recurring subscription. Two things happen on
 * Oblien:
 *   1. `resetQuota` — zero `quota_used` for (namespace, compute) so the
 *      new period starts at 0.
 *   2. `setQuota` — reaffirm the tier's monthlyCredits ceiling. Redundant
 *      when the tier hasn't changed, but cheap and keeps the renewal
 *      path symmetric with the upgrade path.
 *
 * Both calls are idempotent on Oblien's side, and we also share the period
 * anchor (org, period_start) with the anniversary cron — whichever fires
 * first wins. The initial invoice (`subscription_create`) is skipped here
 * because checkout.session.completed already set the quota; resetting on
 * the first day would zero a counter that's already zero, harmless but
 * noisy.
 *
 * One-shot pack invoices land here too with no subscription id; we skip
 * them — `checkout.session.completed` mode=payment already credited them.
 */
async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  // Invoice objects may carry subscription as id or expanded. Be defensive.
  const subRef = (invoice as unknown as { subscription?: string | { id: string } })
    .subscription;
  const stripeSubscriptionId =
    typeof subRef === "string" ? subRef : subRef?.id ?? null;
  if (!stripeSubscriptionId) {
    // Pack purchases come through as one-off invoices with no subscription;
    // they're credited via checkout.session.completed. Nothing to do here.
    return;
  }

  if (invoice.billing_reason === "subscription_create") {
    // Initial invoice — checkout.session.completed already set the quota.
    return;
  }

  // Look up local sub to attribute org + tier.
  const [localSub] = await db
    .select()
    .from(schema.billingSubscription)
    .where(eq(schema.billingSubscription.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  if (!localSub) {
    console.warn(
      `[billing] invoice.paid ${invoice.id} references unknown subscription ${stripeSubscriptionId}`,
    );
    return;
  }

  // Pull the live subscription to get the new period boundaries (the invoice
  // close usually advances current_period_*).
  const sub = await stripe().subscriptions.retrieve(stripeSubscriptionId);
  const planTierId = localSub.planTierId as PlanTierId;

  await upsertSubscription({
    organizationId: localSub.organizationId,
    stripeSubscriptionId: sub.id,
    stripePriceId: resolvePriceIdFromSub(sub),
    planTierId,
    interval: resolveIntervalFromSub(sub),
    status: mapStripeStatusToCanonical(sub.status),
    currentPeriodStart: periodStart(sub),
    currentPeriodEnd: periodEnd(sub),
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
  });

  await resetAndRegrant(localSub.organizationId, planTierId);
}

/* ───────── invoice.payment_failed ───────────────────────────────────────── */

/**
 * Stripe couldn't pull the card. Flip the org into past_due so the
 * dashboard banner + middleware messaging surface the problem, and email
 * the org owner so they can update payment before Stripe's dunning runs
 * out.
 *
 * Critically: NO Oblien call here. Payment failure is a billing UX state,
 * not a quota state — the user still has whatever allowance they had a
 * second ago. The only thing that stops workloads is Oblien itself, when
 * credit usage crosses the quota overdraft (`onOverdraftAction:
 * "stop_workspaces"`) — openship never suspends namespaces for billing.
 */
async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const subRef = (invoice as unknown as { subscription?: string | { id: string } })
    .subscription;
  const stripeSubscriptionId =
    typeof subRef === "string" ? subRef : subRef?.id ?? null;
  if (!stripeSubscriptionId) return;

  const [localSub] = await db
    .select()
    .from(schema.billingSubscription)
    .where(eq(schema.billingSubscription.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  if (!localSub) return;

  await db
    .update(schema.organization)
    .set({ subscriptionStatus: "past_due" })
    .where(eq(schema.organization.id, localSub.organizationId));

  // Notify the org owner. Failure to send isn't fatal — the dashboard banner
  // is the real signal, mail is best-effort.
  await notifyPastDue(localSub.organizationId, invoice).catch((err) =>
    console.warn(
      "[billing] past_due notification send failed:",
      safeErrorMessage(err),
    ),
  );
}

/* ───────── customer.deleted ─────────────────────────────────────────────── */

/**
 * The Stripe customer was hard-deleted (admin tooling, GDPR erasure, etc.).
 * Null out the local stripe_customer_id pointer on the org row AND drop
 * the billing_customer mapping. The mapping is what
 * `getOrCreateStripeCustomerId` reads first to skip Stripe round-trips —
 * leaving the row in place would have the next checkout try to reuse
 * the dead Stripe id and 404. Deletion is the right call (not "set
 * stripeCustomerId = null") because the table's UNIQUE-on-org constraint
 * makes the row meaningless without a live Stripe id.
 *
 * The Oblien namespace is left untouched — a deleted Stripe customer
 * doesn't mean the org is gone, and historical usage rows on Oblien
 * still need a home.
 */
async function handleCustomerDeleted(customer: Stripe.Customer): Promise<void> {
  await db
    .update(schema.organization)
    .set({ stripeCustomerId: null })
    .where(eq(schema.organization.stripeCustomerId, customer.id));

  await db
    .delete(schema.billingCustomer)
    .where(eq(schema.billingCustomer.stripeCustomerId, customer.id));
}

/* ───────── Helpers ──────────────────────────────────────────────────────── */

function resolvePriceIdFromSub(sub: Stripe.Subscription): string {
  // First subscription item drives the tier — we never sell multi-item subs.
  const item = sub.items?.data?.[0];
  return item?.price?.id ?? "";
}

function resolveIntervalFromSub(sub: Stripe.Subscription): "monthly" | "annual" {
  const item = sub.items?.data?.[0];
  const recurring = item?.price?.recurring;
  if (recurring?.interval === "year") return "annual";
  return "monthly";
}

/**
 * Reverse-map a Stripe price id back to a tier.
 *
 * Iterates PLAN_IDS — the catalog's own list — rather than a hand-written tuple.
 * The tuple this replaced was `["pro", "team", "enterprise"]`, so a tier added to
 * the catalog was invisible here and every `subscription.updated` / `invoice.paid`
 * for it resolved to the `"free"` fallback: a silent downgrade of a paying
 * customer, with the quota push to match. Anything the catalog can sell, this
 * must be able to read back.
 */
function resolvePlanFromPriceId(sub: Stripe.Subscription): PlanTierId {
  const priceId = resolvePriceIdFromSub(sub);
  if (!priceId) return "free";
  for (const tier of PLAN_IDS) {
    if (
      resolveStripePriceId(tier, "monthly") === priceId ||
      resolveStripePriceId(tier, "annual") === priceId
    ) {
      return tier;
    }
  }
  return "free";
}

async function resolveOrgFromSubscription(
  sub: Stripe.Subscription,
): Promise<string | null> {
  // Prefer the metadata fast-path (set at checkout time).
  const metaOrg = sub.metadata?.organizationId;
  if (metaOrg) return metaOrg;

  // Fall back to the customer mapping table.
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const [row] = await db
    .select({ organizationId: schema.billingCustomer.organizationId })
    .from(schema.billingCustomer)
    .where(eq(schema.billingCustomer.stripeCustomerId, customerId))
    .limit(1);
  return row?.organizationId ?? null;
}

/**
 * Resolve the subscription's current period boundaries.
 *
 * The fields moved from `subscription.current_period_*` to
 * `subscription.items.data[0].current_period_*` in a recent Stripe API
 * version, and the pinned `STRIPE_API_VERSION` (lib/stripe-client.ts)
 * targets that vintage. The types library still ships the item-level
 * declaration; some webhook payloads (older live-mode shadows, manual
 * fixtures) carry the root-level field — read the item path first and
 * fall back. When you bump the API version, audit this helper alongside
 * the rest of the webhook surface.
 */
function periodStart(sub: Stripe.Subscription): Date {
  const itemLevel = sub.items?.data?.[0]?.current_period_start;
  const rootLevel = (sub as unknown as { current_period_start?: number })
    .current_period_start;
  const raw = itemLevel ?? rootLevel;
  return raw ? new Date(raw * 1000) : new Date();
}

function periodEnd(sub: Stripe.Subscription): Date {
  const itemLevel = sub.items?.data?.[0]?.current_period_end;
  const rootLevel = (sub as unknown as { current_period_end?: number })
    .current_period_end;
  const raw = itemLevel ?? rootLevel;
  return raw ? new Date(raw * 1000) : new Date();
}

/* ───────── Past-due notification ────────────────────────────────────────── */

async function notifyPastDue(
  organizationId: string,
  invoice: Stripe.Invoice,
): Promise<void> {
  const owner = await resolveOrgOwner(organizationId, "first-member");
  if (!owner?.user?.email) return;

  const amount = ((invoice.amount_due ?? 0) / 100).toFixed(2);
  const hostedInvoiceUrl = invoice.hosted_invoice_url ?? "";
  await sendMail({
    to: owner.user.email,
    subject: "Action required: payment failed",
    html: `
      <p>Hi ${owner.user.name ?? "there"},</p>
      <p>We weren't able to charge your card for invoice <strong>${invoice.number ?? invoice.id}</strong> (${amount} ${(invoice.currency ?? "usd").toUpperCase()}).</p>
      <p>Your workspace is now in <strong>past_due</strong> — please update your payment method to restore full access.</p>
      ${hostedInvoiceUrl ? `<p><a href="${hostedInvoiceUrl}">Update payment method</a></p>` : ""}
      <p>— Openship</p>
    `,
    text: `We weren't able to charge your card for invoice ${invoice.number ?? invoice.id} (${amount}). Update payment to restore access: ${hostedInvoiceUrl}`,
    organizationId,
  });
}
