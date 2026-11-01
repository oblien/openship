import { createHash } from "node:crypto";
import { z } from "zod";
import type { ManagementPlanId } from "@repo/contracts";
import { AppError, PRICING } from "@repo/core";
import type {
  OblienEntitlement,
  OblienOffer,
  OblienSubscription,
} from "../../lib/oblien-billing-api";

const termFields = {
  servers: z.number().int().min(2).max(100),
  includedServers: z.number().int().min(1).max(100),
  baseIncluded: z.boolean(),
  basePriceCents: z.number().int().nonnegative(),
  extraServerMonthlyCents: z.number().int().positive(),
};
export const managementTermsSchema = z.discriminatedUnion("version", [
  z.object({ version: z.literal(1), ...termFields }).strict(),
  z.object({ version: z.literal(2), ...termFields,
    plan: z.enum(["basic", "priority"]), supportMonthlyCents: z.number().int().nonnegative(),
  }).strict(),
]).refine(terms => terms.servers >= terms.includedServers && (!terms.baseIncluded || terms.basePriceCents === 0) &&
  (terms.version === 1 || (terms.plan === "basic" ? terms.supportMonthlyCents === 0 : terms.supportMonthlyCents > 0)));
type Terms = z.infer<typeof managementTermsSchema>;
export const managementPlan = (terms: Terms): ManagementPlanId => terms.version === 1 ? "basic" : terms.plan;
const reference = (terms: Terms) =>
  `openship:manage:v${terms.version}:${createHash("sha256").update(JSON.stringify(terms)).digest("hex").slice(0, 24)}`;
const price = (terms: Terms) =>
  terms.basePriceCents + (terms.version === 2 ? terms.supportMonthlyCents : 0) +
  (terms.servers - terms.includedServers) * terms.extraServerMonthlyCents;
const mismatch = () =>
  new AppError(
    "The management subscription does not match this organization",
    502,
    "MANAGEMENT_BILLING_MISMATCH",
  );
export function parseManagementTerms(value: string | undefined): Terms {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? "null");
  } catch {
    throw mismatch();
  }
  const result = managementTermsSchema.safeParse(parsed);
  if (!result.success) throw mismatch();
  return result.data;
}

export function managementOffer(
  organizationId: string,
  namespace: string,
  servers: number,
  cloudIncluded: boolean,
  plan: ManagementPlanId = "basic",
) {
  const catalog = PRICING.management;
  if (
    !Number.isSafeInteger(servers) ||
    servers < catalog.includedServers ||
    servers > catalog.maxServers
  )
    throw new AppError(
      "Choose a supported number of connected servers",
      400,
      "MANAGEMENT_SERVER_COUNT_INVALID",
    );
  const terms = managementTermsSchema.parse({
    version: catalog.version,
    plan,
    supportMonthlyCents: plan === "priority" ? catalog.priorityMonthlyCents - catalog.monthlyCents : 0,
    servers,
    includedServers: catalog.includedServers,
    baseIncluded: cloudIncluded,
    basePriceCents: cloudIncluded ? 0 : catalog.monthlyCents,
    extraServerMonthlyCents: catalog.extraServerMonthlyCents,
  });
  return offerForTerms(organizationId, namespace, terms);
}

function offerForTerms(organizationId: string, namespace: string, terms: Terms) {
  const servers = terms.servers;
  const unitAmount = price(terms);
  if (!unitAmount)
    throw new AppError(
      "Your Cloud plan already includes this management allowance",
      409,
      "MANAGEMENT_INCLUDED",
    );
  const offer: OblienOffer = {
    reference: reference(terms),
    name: `Openship Manage ${managementPlan(terms) === "priority" ? "Priority" : "Basic"}`,
    description: `Hosted management for ${servers} customer-owned servers with ${managementPlan(terms) === "priority" ? "priority" : "email"} support. Compute and storage are provided by you.`,
    currency: "usd",
    unitAmount,
    billingMode: "service",
    credits: 0,
  };
  return {
    offer,
    metadata: {
      openship_product: "manage",
      openship_organization: organizationId,
      openship_namespace: namespace,
      openship_management: JSON.stringify(terms),
    },
  };
}

/** Saved terms survive catalog changes; neither an event payload nor a browser
 * selection grants access. The provider must confirm the paid cycle. */
export function managementTerms(
  organizationId: string,
  namespace: string,
  subscription: OblienSubscription,
) {
  if (!subscription) return null;
  const metadata = subscription.metadata;
  const terms = parseManagementTerms(metadata?.openship_management);
  if (
    metadata?.openship_product !== "manage" ||
    metadata.openship_organization !== organizationId ||
    metadata.openship_namespace !== namespace ||
    subscription.billingInterval !== "monthly" ||
    subscription.offer?.billingMode !== "service" ||
    subscription.offer.reference !== reference(terms) ||
    subscription.offer.unitAmount !== price(terms) ||
    subscription.offer.credits !== 0
  )
    throw mismatch();
  return terms;
}

export function managementSubscription(
  organizationId: string,
  namespace: string,
  subscription: OblienSubscription,
) {
  const terms = managementTerms(organizationId, namespace, subscription);
  return terms && subscription
    ? {
        plan: managementPlan(terms),
        servers: terms.servers,
        baseIncluded: terms.baseIncluded,
        priceCents: subscription.offer!.unitAmount,
        periodEnd: subscription.periodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        status: subscription.status,
      }
    : null;
}

export function paidManagement(
  organizationId: string,
  namespace: string,
  subscription: OblienSubscription,
  entitlement: OblienEntitlement,
  now = Date.now(),
) {
  const contract = managementSubscription(organizationId, namespace, subscription);
  if (!contract || !subscription) return null;
  if (
    entitlement.namespace !== namespace ||
    entitlement.billingMode !== "service" ||
    entitlement.computeCovered !== false ||
    Date.parse(entitlement.periodEnd ?? "") !== Date.parse(subscription.periodEnd ?? "") ||
    Date.parse(entitlement.periodStart ?? "") !== Date.parse(subscription.periodStart ?? "")
  )
    throw new AppError(
      "The paid management cycle could not be verified",
      502,
      "MANAGEMENT_BILLING_MISMATCH",
    );
  const end = Date.parse(subscription.periodEnd ?? "");
  if (
    !entitlement.serviceCovered ||
    entitlement.status !== "active" ||
    !["active", "trialing", "past_due"].includes(subscription.status) ||
    !Number.isFinite(end) ||
    end <= now
  )
    return null;
  return { ...contract, periodEnd: subscription.periodEnd! };
}

export function managementServerLimit(
  paid: { servers: number; baseIncluded: boolean; periodEnd: string } | null,
  cloudCoveredUntil: Date | null,
  now = Date.now(),
) {
  const included =
    PRICING.management.includedWithCloud && (cloudCoveredUntil?.getTime() ?? 0) > now;
  const paidLimit = paid && Date.parse(paid.periodEnd) > now ? paid.servers : 0;
  return Math.max(included ? PRICING.management.includedServers : 0, paidLimit);
}

/** Waive only the base fee; retain this customer's saved extra-server terms. */
export function managementCloudBenefitOffer(
  organizationId: string,
  namespace: string,
  subscription: OblienSubscription,
) {
  const terms = managementTerms(organizationId, namespace, subscription);
  if (!terms || terms.baseIncluded || price(terms) === terms.basePriceCents) return null;
  return offerForTerms(organizationId, namespace, {
    ...terms,
    baseIncluded: true,
    basePriceCents: 0,
  });
}
