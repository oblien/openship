import { createHash, randomUUID } from "node:crypto";
import { AppError, mailMonthlyCents, PRICING } from "@repo/core";
import { repos } from "@repo/db";
import { z } from "zod";
import { paidComputeCoverage } from "../billing/compute-coverage";
import type { MailPlan } from "@repo/contracts/managed-mail";
import { PAID_MAIL_PLANS, type MailProduct, type PaidMailPlan } from "@repo/core/managed-mail";
import { env, runtimeTarget } from "../../config/env";
import { getOblienBillingApi } from "../../lib/oblien-client";
import { ensureCloudNamespace } from "../../lib/oblien-namespace";
import { isExpiredCheckout } from "../billing/workspace-checkout";
import { createProvisionLock } from "../../lib/provision-lock";

const paidPlan = z.enum(PAID_MAIL_PLANS);
export const sendingNamespace = (org: string) =>
  "openship-mail-" + createHash("sha256").update(org).digest("hex").slice(0, 32);
export async function ensureMailAccount(org: string) {
  const namespace = sendingNamespace(org);
  await repos.managedMail.ensureAccount(org, namespace);
  const row = await repos.managedMail.account(org);
  if (!row || row.namespace !== namespace)
    throw new AppError("Unexpected mail account owner.", 409);
  if (!row.namespaceReady) {
    await ensureCloudNamespace({
      name: "Openship Mail",
      slug: namespace,
      resource_limits: {
        max_vms: 0,
        max_vcpus: 0,
        max_ram_mb: 0,
        max_disk_gb: 0,
        max_total_vcpus: 0,
        max_total_ram_mb: 0,
        max_total_disk_gb: 0,
      },
    });
    await repos.managedMail.updateAccount(org, { namespaceReady: true });
  }
  return row;
}

export function mailServiceOffer(plan: PaidMailPlan, product: Exclude<MailProduct, "dedicated">) {
  const sending = product === "sending";
  return {
    reference: `openship:mail:v${PRICING.mail.version}:${sending ? "sending:" : ""}${plan}`,
    name: (sending ? "OpenShip Email API " : "Openship Mail ") + plan,
    description: sending
      ? "Managed outbound sending via the Email API"
      : "Hosted mailboxes and managed outbound sending",
    billingMode: "service" as const,
    currency: "usd" as const,
    unitAmount: mailMonthlyCents(plan, product),
    credits: 0,
  };
}

export async function paidEmailPlan(
  org: string,
): Promise<{ plan: PaidMailPlan; until: Date; dedicated: boolean; sendingOnly: boolean } | null> {
  const row = await repos.managedMail.account(org);
  if (!row?.namespaceReady) return null;
  const provider = getOblienBillingApi();
  const { subscription } = await provider.getSubscription(row.namespace);
  if (!subscription) return null;
  const meta = subscription.metadata;
  const parsed = paidPlan.safeParse(meta?.openship_mail_plan);
  if (!parsed.success) throw new AppError("Unknown mail subscription.", 502);
  const plan = parsed.data;
  // Existing mailbox subscriptions predate the product metadata field.
  const product = z
    .enum(["mailboxes", "sending"])
    .safeParse(meta?.openship_mail_product ?? "mailboxes");
  if (!product.success) throw new AppError("Unknown email product.", 502);
  const terms = mailServiceOffer(plan, product.data);
  if (
    row.namespace !== sendingNamespace(org) ||
    meta?.openship_organization !== org ||
    meta.openship_namespace !== row.namespace ||
    meta.openship_product !== "mail" ||
    subscription.billingInterval !== "monthly" ||
    subscription.offer?.billingMode !== "service" ||
    subscription.offer.reference !== terms.reference ||
    subscription.offer.unitAmount !== terms.unitAmount ||
    subscription.offer.credits !== 0 ||
    subscription.offer.currency !== terms.currency
  )
    throw new AppError("The mail subscription does not match this organization.", 502);
  const until = new Date(subscription.periodEnd ?? "");
  if (
    !["active", "trialing", "past_due"].includes(subscription.status) ||
    !(until.getTime() > Date.now())
  )
    return null;
  const entitlement = await provider.getEntitlement(row.namespace);
  if (
    entitlement.namespace !== row.namespace ||
    entitlement.billingMode !== "service" ||
    entitlement.computeCovered ||
    Date.parse(entitlement.periodEnd ?? "") !== until.getTime() ||
    Date.parse(entitlement.periodStart ?? "") !== Date.parse(subscription.periodStart ?? "")
  )
    throw new AppError("The paid email period could not be verified.", 502);
  if (!entitlement.serviceCovered || entitlement.status !== "active") return null;
  return { plan, until, dedicated: false, sendingOnly: product.data === "sending" };
}

const grantSchema = z.record(
  z.string(),
  z
    .object({
      plan: paidPlan,
      until: z.iso.datetime(),
      dedicated: z.boolean().optional(),
      sendingOnly: z.boolean().optional(),
    })
    .strict(),
);

export interface MailEntitlement {
  plan: MailPlan;
  until: Date;
  dedicated: boolean;
  sendingOnly?: boolean;
  allowance?: { recipients: number; dailyRecipients: number; domains: number };
}
/** Read provider billing once when resolving both capabilities for a workspace. */
export function mailEntitlements(org: string, readSubscription = () => paidEmailPlan(org)) {
  let subscription: ReturnType<typeof paidEmailPlan> | undefined;
  let compute: ReturnType<typeof paidComputeCoverage> | undefined;
  return async (capability: "sending" | "mailboxes"): Promise<MailEntitlement | null> => {
    const grant = configuredGrant(org, capability);
    if (grant) return grant;
    const paid = await (subscription ??= readSubscription());
    if (paid && (capability === "sending" || !paid.sendingOnly)) return paid;
    const until = await (compute ??= paidComputeCoverage(org));
    return until ? { plan: "included", until, dedicated: false } : null;
  };
}

export function mailEntitlement(org: string, capability: "sending" | "mailboxes" = "sending") {
  return mailEntitlements(org)(capability);
}

function configuredGrant(org: string, capability: "sending" | "mailboxes"): MailEntitlement | null {
  let grants: z.infer<typeof grantSchema>;
  try {
    grants = grantSchema.parse(JSON.parse(env.OPENSHIP_MAIL_PLAN_GRANTS ?? "{}"));
  } catch {
    throw new AppError("Managed mail plan grants are misconfigured.", 503, "MAIL_PLAN_CONFIG");
  }
  const grant = grants[org];
  if (
    grant &&
    Date.parse(grant.until) > Date.now() &&
    !(grant.sendingOnly && capability === "mailboxes")
  )
    return {
      plan: grant.plan,
      until: new Date(grant.until),
      dedicated: !!grant.dedicated,
      sendingOnly: grant.sendingOnly,
    };
  return null;
}

function emailReturnUrl(org: string) {
  const url = new URL("/emails", runtimeTarget.dashboard);
  url.searchParams.set("organizationId", org);
  return url.href;
}

type Account = NonNullable<Awaited<ReturnType<typeof repos.managedMail.account>>>;
type Intent = NonNullable<Account["checkout"]>;

async function checkoutSession(row: Account, intent: Intent) {
  const back = emailReturnUrl(row.organizationId);
  const product = intent.product ?? "mailboxes";
  const result = await getOblienBillingApi().createCheckout({
    kind: "subscription",
    billingInterval: "monthly",
    namespace: row.namespace,
    offer: mailServiceOffer(intent.plan, product),
    idempotencyKey: intent.key,
    successUrl: product === "sending" ? back + "&mailView=sending&tab=sending" : back,
    cancelUrl: back,
    metadata: {
      openship_product: "mail",
      openship_namespace: row.namespace,
      openship_organization: row.organizationId,
      openship_mail_plan: intent.plan,
      ...(product === "sending" ? { openship_mail_product: product } : {}),
    },
  });
  if (intent.id && result.checkoutId !== intent.id)
    throw new AppError("Email checkout identity changed.", 502);
  if (!intent.id)
    await repos.managedMail.updateAccount(row.organizationId, {
      checkout: { ...intent, id: result.checkoutId },
    });
  return result;
}

async function checkoutState(namespace: string, id: string) {
  try {
    const { checkout } = await getOblienBillingApi().getCheckout(namespace, id);
    if (checkout.status === "complete") return checkout.fulfilled ? "fulfilled" : "processing";
    return checkout.status;
  } catch (error) {
    if (isExpiredCheckout(error)) return "expired";
    throw error;
  }
}

/** Rendering the pricing page must never create a provider checkout. */
export async function mailCheckoutSummary(
  account: Account | null | undefined,
  hasPaidMail: boolean,
) {
  const intent = account?.checkout;
  if (!account || !intent) return {};
  if (hasPaidMail) return { hasBillingAccount: !!intent.id };
  const state = intent.id ? await checkoutState(account.namespace, intent.id) : "open";
  if (state === "fulfilled" || state === "expired")
    return { hasBillingAccount: state === "fulfilled" };
  return { pendingPlan: intent.plan, pendingProduct: intent.product ?? "mailboxes" };
}

export function assertHostedMailEnrollment() {
  if (!env.OPENSHIP_MAIL_HOSTED_ENROLLMENT_ENABLED)
    throw new AppError("Hosted mailbox enrollment is currently closed.", 503, "MAIL_ENROLLMENT_CLOSED");
}

export async function emailCheckout(
  org: string,
  plan: PaidMailPlan,
  product: Exclude<MailProduct, "dedicated"> = "mailboxes",
) {
  return createProvisionLock("managed-mail:checkout:" + org).run(async () => {
    if (product === "mailboxes") assertHostedMailEnrollment();
    const provider = getOblienBillingApi();
    if (!env.BILLING_ENABLED || !(await provider.getCatalog()).reseller?.serviceOffers)
      throw new AppError("Email checkout is currently unavailable.", 503);
    const row = await ensureMailAccount(org);
    const { subscription } = await provider.getSubscription(row.namespace);
    if (subscription && subscription.status !== "canceled")
      throw new AppError("This organization already has a mail subscription.", 409);
    let intent = row.checkout;
    if (intent) {
      try {
        const session = intent.id ? { checkoutId: intent.id } : await checkoutSession(row, intent);
        const state = await checkoutState(row.namespace, session.checkoutId);
        if (state === "expired" || state === "fulfilled") intent = null;
        else if (state === "processing")
          throw new AppError("The email payment is being reconciled.", 409);
      } catch (error) {
        if (!isExpiredCheckout(error)) throw error;
        intent = null;
      }
    }
    if (intent && (intent.plan !== plan || (intent.product ?? "mailboxes") !== product))
      throw new AppError("Cancel the pending checkout before choosing another plan.", 409);
    if (!intent) {
      if (!PRICING.mail.plans[plan].checkoutAvailable)
        throw new AppError("This email plan is unavailable for checkout.", 409);
      intent = { key: randomUUID(), plan, product };
      await repos.managedMail.updateAccount(org, { checkout: intent });
    }
    return { url: (await checkoutSession(row, intent)).url };
  });
}

export async function cancelEmailCheckout(org: string) {
  return createProvisionLock("managed-mail:checkout:" + org).run(async () => {
    const row = await repos.managedMail.account(org);
    if (!row?.checkout) return { canceled: true };
    try {
      const id = row.checkout.id ?? (await checkoutSession(row, row.checkout)).checkoutId;
      const provider = getOblienBillingApi();
      const state = await checkoutState(row.namespace, id);
      if (state === "processing") throw new AppError("The email payment is being reconciled.", 409);
      if (state === "open") {
        const result = await provider.cancelCheckout(row.namespace, id, {
          idempotencyKey: "cancel-" + row.checkout.key,
        });
        if (result.checkout.status !== "expired")
          throw new AppError("The checkout could not be canceled.", 409);
      }
    } catch (error) {
      if (!isExpiredCheckout(error)) throw error;
    }
    await repos.managedMail.updateAccount(org, { checkout: null });
    return { canceled: true };
  });
}

export async function emailPortal(org: string) {
  const row = await repos.managedMail.account(org);
  if (!row?.namespaceReady || row.namespace !== sendingNamespace(org))
    throw new AppError("No email billing account exists.", 404);
  const { url } = await getOblienBillingApi().createPortal({
    namespace: row.namespace,
    returnUrl: emailReturnUrl(org),
  });
  return { url };
}
