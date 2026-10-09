/** Organization-scoped billing operations. Oblien is the Cloud payment authority. */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type { ExecutionContext } from "../../../context";
import {
  BillingPlansSchema,
  ValidationError,
  normalizeBillingCreditPacks,
  parseInput,
  type BillingOperations,
  type BillingScopeInput,
} from "@repo/contracts";
import { listAuthorizedProjects } from "../../lib/authorized-projects";
import { AppError, FREE_DOMAIN_SUFFIX, cloudRuntimeTarget } from "@repo/core";
import { env } from "../../config/env";
import { getFreeSubdomainUsage, listFreeSubdomains } from "@repo/platform/engine/lib/plan-guard";
import * as billingService from "@repo/platform/engine/modules/billing/billing.service";
import * as billingRepository from "@repo/platform/engine/modules/billing/billing.repository";
import { getNamespaceUsage } from "@repo/platform/engine/modules/billing/billing-oblien-quota";
import { presentCloudPlans } from "./billing-catalog";
import { getBillingResources } from "./billing-resources.service";
import { customSubscriptionOffer } from "./billing-custom-offer";
import { getOblienBillingApi } from "../../lib/oblien-client";
export { previewSubscriptionChange, confirmSubscriptionChange, getSubscriptionChange, cancelSubscriptionChange } from "./billing-plan-change";
export { listCheckouts, resumeCheckout, cancelCheckout } from "./billing-checkout-recovery";
export { getActionsBudget, getActionsPurchase, createActionsCheckout, resumeActionsCheckout } from "../actions/billing-application";

/* ---------- Plans (public) ---------- */

/** Public on every installation: a linked local dashboard must show Cloud's
 * actual prices too. Outside SaaS, read Openship's public catalog without credentials. */
export async function listPlans(input: NonNullable<Parameters<BillingOperations["listPlans"]>[0]>) {
  if (env.CLOUD_MODE) return presentCloudPlans(input.locale, await getOblienBillingApi().assertMonthlyCapacitySupport());
  const url = new URL("/api/billing/plans", cloudRuntimeTarget.api);
  if (input.locale) url.searchParams.set("locale", input.locale);
  try {
    const response = await fetch(url, {
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Cloud catalog unavailable");
    const payload = (await response.json()) as { data?: unknown };
    return parseInput(BillingPlansSchema, payload.data);
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "platform/engine/modules/billing/billing-application.service");
    throw new AppError(
      "Openship Cloud prices are temporarily unavailable. Please retry.",
      503,
      "BILLING_CATALOG_UNAVAILABLE",
    );
  }
}

/* ---------- Billing state (dashboard overview) ---------- */

export async function getState(ctx: ExecutionContext, input: BillingScopeInput = {}) {
  const state = await billingRepository.getBillingState(ctx.organizationId, input.workspaceId);
  return state;
}

export async function getCreditAlerts(ctx: ExecutionContext) {
  return billingRepository.getCreditAlerts(ctx.organizationId);
}

export async function getCheckout(ctx: ExecutionContext, input: { checkoutId: string; workspaceId?: string }) {
  return billingService.getCheckoutStatus(ctx.organizationId, input.checkoutId, input.workspaceId);
}

export async function getResources(ctx: ExecutionContext, input: BillingScopeInput = {}) {
  return getBillingResources(ctx.organizationId, input.workspaceId);
}

/* ---------- Subscriptions ---------- */

export async function quoteCustomPlan(_ctx: ExecutionContext, input: Parameters<BillingOperations["quoteCustomPlan"]>[0]) {
  await getOblienBillingApi().assertMonthlyCapacitySupport();
  const { quote } = customSubscriptionOffer(input);
  return quote;
}

export async function createSubscription(ctx: ExecutionContext, input: NonNullable<Parameters<BillingOperations["createSubscription"]>[0]>) {
  const { planTierId, interval } = input;

  const { checkoutUrl } = await billingService.createCheckoutSession(
    ctx,
    planTierId,
    interval,
    input.idempotencyKey,
    input.workspaceId,
    input.custom,
  );

  return { checkoutUrl };
}

export async function cancelSubscription(ctx: ExecutionContext, input: BillingScopeInput = {}) {
  const result = await billingService.cancelSubscription(ctx.organizationId, input.workspaceId);
  return result;
}

export async function resumeSubscription(ctx: ExecutionContext, input: BillingScopeInput = {}) {
  return billingService.resumeSubscription(ctx.organizationId, input.workspaceId);
}

/* ---------- Top-ups ---------- */

export async function createTopup(ctx: ExecutionContext, input: NonNullable<Parameters<BillingOperations["createTopup"]>[0]>) {
  const { packId } = input;

  const { checkoutUrl } = await billingService.createTopupCheckoutSession(
    ctx,
    packId,
    input.idempotencyKey,
    input.workspaceId,
  );

  return { checkoutUrl };
}

/** Openship's credit packs; prices and credits come from the same server catalog. */
export async function listTopupPacks(_ctx: ExecutionContext) {
  return normalizeBillingCreditPacks(await billingService.listActiveCreditPacks());
}

/* ---------- Allowance detail (what is using my quota) ---------- */

/**
 * ITEMIZE the allowances a user can act on — currently the free `*.opsh.io`
 * subdomains.
 *
 * The capacity meters answer "how much of my quota is gone"; this answers "gone
 * WHERE", which is the only version a user can do anything about. Before this
 * there was no way to find out: the dashboard's domains page is a stub,
 * `GET /api/domains` requires a `projectId`, and `openship domain list` requires
 * `--project` — so a free subdomain created by a CLI deploy into a since-forgotten
 * project silently consumed a slot with nothing to enumerate it.
 *
 * Each row carries its `domainId` so a client can offer Release directly.
 */
export async function listAllowanceDetail(ctx: ExecutionContext, input: BillingScopeInput = {}) {

  const [usage, slots] = await Promise.all([
    getFreeSubdomainUsage(ctx.organizationId, undefined, input.workspaceId),
    listFreeSubdomains(ctx.organizationId, input.workspaceId),
  ]);
  const restrictedProjects = ctx.tokenScope || ctx.role === "restricted"
    ? new Set((await listAuthorizedProjects(ctx, ctx.organizationId)).map(project => project.id)) : null;

  return {
      freeSubdomains: {
        used: usage.used,
        limit: usage.limit,
        remaining: usage.remaining,
        suffix: FREE_DOMAIN_SUFFIX,
        items: slots.filter(s => !restrictedProjects || (s.projectId && restrictedProjects.has(s.projectId))).map((s) => ({
          domainId: s.domainId,
          hostname: s.hostname,
          projectId: s.projectId,
          projectName: s.projectName,
          projectSlug: s.projectSlug,
          serviceId: s.serviceId,
          createdAt: s.createdAt,
        })),
      },
    };
}

/* ---------- Portal ---------- */

export async function createPortal(ctx: ExecutionContext, input: BillingScopeInput = {}) {
  const { portalUrl } = await billingService.createPortalSession(ctx.organizationId, input.workspaceId);
  return { portalUrl };
}

/* ---------- Raw metered usage (buckets + totals) ---------- */

/**
 * Proxy to Oblien's `namespaces.usageUnits` rollup. Powers the
 * dashboard's usage chart and the credits-spent breakdown.
 *
 * Query params (all optional, ISO8601):
 *   - `from`  default: 30 days ago
 *   - `to`    default: now
 *   - `groupBy` "hour" | "day", default "day"
 *
 * Returns the resolved range echoed back alongside Oblien's payload
 * so the chart doesn't have to re-derive the window when the caller
 * relied on defaults. `usage` is `null` when the org has no namespace
 * yet — the dashboard renders an empty state in that case.
 */
export async function getUsage(ctx: ExecutionContext, input: NonNullable<Parameters<BillingOperations["getUsage"]>[0]>) {

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const fromParam = input.from;
  const toParam = input.to;
  const from = fromParam ? new Date(fromParam) : thirtyDaysAgo;
  const to = toParam ? new Date(toParam) : now;

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return invalidInput("Invalid `from` or `to` — expected ISO8601");
  }

  if (to < from) throw new ValidationError("Range end must not precede its start");
  if (to.getTime() - from.getTime() > 366 * 86_400_000) throw new ValidationError("Billing usage ranges cannot exceed 366 days");
  const groupByParam = input.groupBy;
  if (groupByParam && groupByParam !== "hour" && groupByParam !== "day") {
    return invalidInput("Invalid `groupBy` — expected \"hour\" or \"day\"");
  }
  const groupBy: "hour" | "day" = groupByParam === "hour" ? "hour" : "day";

  const usage = await getNamespaceUsage({
    organizationId: ctx.organizationId,
    workspaceId: input.workspaceId,
    from,
    to,
    groupBy,
  });

  return {
      from: from.toISOString(),
      to: to.toISOString(),
      groupBy,
      usage,
    };
}

/* ---------- Subscription getter ---------- */

/**
 * Subscription-only sub-slice of the billing state. Kept separate from
 * `getState` so callers (and the local proxy) can poll just the
 * subscription row without re-fetching the credit balance.
 */
export async function getSubscription(ctx: ExecutionContext, input: BillingScopeInput = {}) {
  const state = await billingRepository.getBillingState(ctx.organizationId, input.workspaceId);
  return {
      tier: state.tier,
      status: state.status,
      currentPeriod: state.currentPeriod,
      subscription: state.subscription,
    };
}
function invalidInput(message: string): never { throw new ValidationError(message); }
