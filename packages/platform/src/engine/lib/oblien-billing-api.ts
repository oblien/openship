import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { z } from "zod";
import { AppError } from "@repo/core";
import { OperationError } from "@repo/contracts";
import { Oblien } from "@repo/adapters";
import { isDeepStrictEqual } from "node:util";
import { computeBillingModeSchema, oblienCapacityCatalogSchema, oblienCapacityPoolSchema, oblienNamespaceCapacitySchema } from "./oblien-capacity";

// Oblien owns payments and credits. Validate its SDK responses at our tenant
// boundary before returning customer data or hosted billing session URLs.
const amount = z.number().finite();
const allowance = amount.nonnegative().nullable();
const date = z.string().refine((value) => Number.isFinite(Date.parse(value))).nullable();
const namespace = z.string().min(1).max(128);
const timestamp = (value: string | null) => value === null ? null : Date.parse(value);
// The live credit meter, distinct from proposed rate cards or monthly capacity.
// Actions offers sell 100 credits per dollar; reject a changed conversion rather
// than silently quote a different purchasing power.
export const oblienMeteredPricingSchema = z.object({
  success: z.literal(true),
  credits_per_dollar: z.literal(100),
  rate_card_id: z.string().min(1),
  rates: z.object({
    cpu_per_min: amount.positive(),
    memory_per_gb_min: amount.positive(),
    disk_per_gb: amount.nonnegative(),
    network_per_gb: amount.nonnegative(),
  }),
});
// These validation refusals occur before a checkout is opened. Use the original
// provider status: an operator's funding or eligibility error is presented as 503.
const REJECTED_CHECKOUT_CODES = new Set([
  "invalid_plan", "invalid_pack", "invalid_offer", "invalid_redirect_url",
  "billing_redirect_not_allowed", "reseller_enterprise_required", "billing_offer_underfunded",
  "capacity_price_below_cost", "insufficient_redeemable_balance",
]);
const EXPIRED_CHECKOUT_CODES = new Set(["checkout_expired", "capacity_checkout_expired"]);

export const oblienCatalogSchema = z.object({
  success: z.literal(true),
  reseller: z
    .object({
      contractVersion: amount.int().positive(),
      offerPolicy: z.boolean(),
      resourceLimits: z.boolean(),
      effectiveResourceLimits: z.boolean().optional(),
      aggregateResourceLimits: z.boolean().optional(),
    })
    .optional(),
  plans: z.array(
    z.object({
      tierId: z.string().min(1),
      name: z.string().min(1),
      description: z.string().nullable().optional(),
      priceMonthly: allowance,
      priceYearly: allowance,
      currency: z.string(),
      creditsPerCycle: allowance,
      yearlyCreditsPerCycle: allowance,
      overdraftCredits: allowance.optional(),
      features: z.array(z.string()),
      popular: z.boolean().optional(),
    }),
  ),
  creditPacks: z.array(
    z.object({
      packId: z.string().min(1),
      name: z.string(),
      credits: amount.positive(),
      price: amount.nonnegative(),
      currency: z.string(),
      popular: z.boolean().optional(),
    }),
  ),
});

export const oblienQuotaAlertSchema = z.object({
  state: z.enum(["ok", "low", "grace", "depleted", "unlimited", "disabled"]),
  thresholds: z.array(amount.positive().max(100)), threshold: amount.nullable(),
  percent: amount.nullable(), used: amount, limit: allowance,
  remaining: amount.nullable(), balance: amount.nullable(), overdraft: amount.nonnegative(), blocking: z.boolean(),
});
export type OblienQuotaAlert = z.infer<typeof oblienQuotaAlertSchema>;

export const oblienEntitlementSchema = z.object({
  success: z.literal(true), namespace,
  tierId: z.string().nullable(),
  status: z.enum(["active", "past_due", "canceled", "credit_exhausted"]),
  periodStart: date, periodEnd: date,
  billingMode: computeBillingModeSchema.optional(),
  computeCovered: z.boolean().optional(),
  capacity: oblienNamespaceCapacitySchema.nullable().optional(),
  // Preserve signed legacy usage; the provider's limit includes purchased credits.
  quota: z.object({
    limit: allowance,
    used: amount,
    balance: amount.nullable(),
    overdraft: amount.nonnegative().optional(),
    suspendThreshold: allowance.optional(),
    alert: oblienQuotaAlertSchema.nullable().optional(),
  }),
}).superRefine((value, ctx) => {
  if (value.tierId !== "capacity") {
    if (value.capacity || value.billingMode === "monthly")
      ctx.addIssue({ code: "custom", message: "Capacity requires a capacity entitlement" });
    return;
  }
  const capacity = value.capacity;
  if (!capacity || capacity.namespace !== value.namespace || capacity.billingMode !== value.billingMode ||
      capacity.computeCovered !== value.computeCovered || timestamp(capacity.periodStart) !== timestamp(value.periodStart) ||
      timestamp(capacity.periodEnd) !== timestamp(value.periodEnd)) {
    ctx.addIssue({ code: "custom", message: "Capacity entitlement does not match its saved contract" });
  }
});

export const oblienOfferResourceLimitsSchema = z.object({
  max_workspaces: allowance,
  max_vcpus: allowance,
  max_ram_mb: allowance,
  max_disk_gb: allowance,
  max_total_vcpus: allowance.optional(),
  max_total_ram_mb: allowance.optional(),
  max_total_disk_gb: allowance.optional(),
});
export const oblienOfferSchema = z.object({
  reference: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  unitAmount: amount.int().nonnegative().max(1_000_000),
  currency: z.literal("usd"),
  billingMode: computeBillingModeSchema.optional(),
  capacity: oblienCapacityPoolSchema.optional(),
  tariffId: z.string().min(1).optional(),
  credits: amount.int().min(0).max(1_000_000_000),
  policy: z
    .object({
      overdraft: amount.int().nonnegative(),
      suspendThreshold: amount.int().nonnegative(),
      onOverdraftAction: z.enum(["block", "stop_workspaces"]),
    })
    .refine((value) => value.suspendThreshold >= value.overdraft)
    .optional(),
  resourceLimits: oblienOfferResourceLimitsSchema.optional(),
}).superRefine((value, ctx) => {
  // A sponsored monthly offer charges the customer zero; Oblien still requires
  // the reseller's wallet to fund its capacity before granting coverage.
  if (value.unitAmount < 100 && !(value.unitAmount === 0 && value.billingMode === "monthly"))
    ctx.addIssue({ code: "custom", path: ["unitAmount"], message: "Offers require at least 100 cents unless monthly capacity is fully sponsored" });
  if (value.billingMode === "monthly") {
    if (!value.capacity || value.credits !== 0 || value.policy !== undefined)
      ctx.addIssue({ code: "custom", message: "Monthly capacity requires a pool, zero credits and no credit policy" });
  } else if (value.credits <= 0 || value.capacity !== undefined || value.tariffId !== undefined) {
    ctx.addIssue({ code: "custom", message: "Metered offers require credits and cannot purchase capacity" });
  }
});
export type OblienOffer = z.infer<typeof oblienOfferSchema>;

const billingId = z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/);
const cents = amount.int().nonnegative();
export const oblienPlanChangeInputSchema = z.object({
  offer: oblienOfferSchema,
  metadata: z.record(z.string(), z.string()),
  billingInterval: z.enum(["monthly", "yearly"]),
  idempotencyKey: z.string().min(1).max(128),
}).refine(value => value.offer.billingMode !== "monthly" || value.billingInterval === "monthly",
  "Monthly capacity requires a monthly subscription");
export type OblienPlanChangeInput = z.infer<typeof oblienPlanChangeInputSchema>;
export const oblienPlanChangeQuoteSchema = z.object({
  id: billingId, namespace, direction: z.enum(["upgrade", "downgrade"]),
  expiresAt: date.unwrap(), effectiveAt: date.unwrap(),
  billingInterval: z.enum(["monthly", "yearly"]),
  current: oblienOfferSchema, next: oblienOfferSchema, currency: z.literal("usd"),
  unusedTimeCredit: cents, remainingTimeCharge: cents, amountDueNow: cents,
  nextInvoiceAmount: cents.nullable(), includedCreditIncrease: amount.nonnegative(),
  preservesUsage: z.literal(true), preservesPurchasedCredits: z.literal(true),
});
export const oblienPlanChangeSchema = z.object({
  id: billingId, quoteId: billingId, namespace,
  direction: z.enum(["upgrade", "downgrade"]),
  status: z.enum(["queued", "dispatching", "payment_pending", "scheduled", "canceling",
    "reconciliation_required", "applied", "canceled", "expired", "failed"]),
  effectiveAt: date.unwrap(), current: oblienOfferSchema, next: oblienOfferSchema,
  amountDueNow: cents, currency: z.literal("usd"), includedCreditIncrease: amount.nonnegative(),
  payment: z.object({ status: z.string(), url: z.url().nullable(), expiresAt: date }).nullable(),
  error: z.object({ code: z.string().max(128), message: z.string().max(2000) }).nullable(),
  cancelable: z.boolean(), appliedAt: date,
});
export type OblienPlanChangeQuote = z.infer<typeof oblienPlanChangeQuoteSchema>;
export type OblienPlanChange = z.infer<typeof oblienPlanChangeSchema>;

const policySchema = z.object({
  success: z.literal(true), service: z.literal("workspace_vm"),
  quotaLimit: allowance, overdraft: amount.nonnegative(),
  onOverdraftAction: z.enum(["stop_workspaces", "block"]), suspendThreshold: allowance,
});
const checkoutSchema = z.object({ success: z.literal(true), url: z.url(), checkoutId: z.string().min(1) });
const portalSchema = z.object({ success: z.literal(true), namespace, url: z.url() });
export const oblienSubscriptionSchema = z.object({
  success: z.literal(true),
  namespace,
  subscription: z
    .object({
      tierId: z.string().min(1),
      status: z.enum(["active", "trialing", "past_due", "unpaid", "paused", "canceled"]),
      billingInterval: z.enum(["monthly", "yearly"]),
      periodStart: date,
      periodEnd: date,
      cancelAtPeriodEnd: z.boolean(),
      canceledAt: date,
      offer: oblienOfferSchema.optional(),
      metadata: z.record(z.string(), z.string()).optional(),
      pendingChange: oblienPlanChangeSchema.nullable().optional(),
    })
    .nullable(),
});

export type OblienBillingCatalog = z.infer<typeof oblienCatalogSchema>;
export type OblienEntitlement = z.infer<typeof oblienEntitlementSchema>;
export type OblienBillingPolicy = z.infer<typeof policySchema>;
export type OblienSubscription = z.infer<typeof oblienSubscriptionSchema>["subscription"];
/** An echoed namespace alone cannot prove a paid entitlement belongs to it. */
export function assertOblienEntitlementMatchesSubscription(entitlement: OblienEntitlement, subscription: OblienSubscription): void {
  const monthly = subscription?.offer?.billingMode === "monthly";
  const expectedTier = monthly ? "capacity" : subscription?.tierId ?? "free";
  const capacity = entitlement.capacity;
  if ((entitlement.tierId ?? "free") !== expectedTier ||
      (monthly && (!capacity || capacity.namespace !== entitlement.namespace || capacity.provider !== "stripe" ||
        capacity.billingMode !== "monthly" || entitlement.billingMode !== "monthly" ||
        capacity.computeCovered !== entitlement.computeCovered ||
        !isDeepStrictEqual(capacity.capacity, subscription!.offer!.capacity) ||
        timestamp(capacity.periodStart) !== timestamp(entitlement.periodStart) || timestamp(capacity.periodEnd) !== timestamp(entitlement.periodEnd))) ||
      (!subscription && (entitlement.periodStart !== null || entitlement.periodEnd !== null)) ||
      (subscription && timestamp(subscription.periodStart) !== timestamp(entitlement.periodStart)) ||
      (subscription && timestamp(subscription.periodEnd) !== timestamp(entitlement.periodEnd)) ||
      (!monthly && entitlement.status === "active" && subscription && !["active", "trialing"].includes(subscription.status))) {
    throw new AppError("Cloud billing returned an entitlement that does not match this organization's subscription", 502, "OBLIEN_ENTITLEMENT_MISMATCH");
  }
}

const checkoutInput = z.object({
  namespace: z.string().min(1), successUrl: z.url(), cancelUrl: z.url(),
  idempotencyKey: z.string().min(1), offer: oblienOfferSchema, metadata: z.record(z.string(), z.string()),
});
export const oblienCheckoutInputSchema = z.discriminatedUnion("kind", [
  checkoutInput.extend({ kind: z.literal("subscription"), billingInterval: z.enum(["monthly", "yearly"]) }),
  checkoutInput.extend({ kind: z.literal("topup") }),
]).refine(value => value.offer.billingMode !== "monthly" ||
  (value.kind === "subscription" && value.billingInterval === "monthly"),
  "Monthly capacity requires a monthly subscription");
export type OblienCheckout = z.infer<typeof oblienCheckoutInputSchema>;

/** Log only a bounded error identifier, never provider messages or payment data. */
function providerErrorCode(payload: unknown): string {
  const failure = payload as { code?: unknown; error?: unknown } | null;
  const code = typeof failure?.code === "string" ? failure.code : failure?.error;
  if (typeof code !== "string" || !/^[a-z][a-z0-9_]{0,79}$/i.test(code) ||
      /^(?:oblien|sk|pk|whsec|cus|sub|cs|pi|pm|acct)_/i.test(code)) return "unknown";
  return code;
}

/** Only the documented diagnostic fields may cross the provider boundary. */
function providerDiagnostic(payload: unknown, credentials: (string | undefined)[]) {
  const details = (payload as { details?: { reference?: unknown; retryable?: unknown } } | null)?.details;
  const value = details?.reference;
  const reference = typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)
    && !/^(?:oblien|sk|pk|whsec|cus|sub|cs|pi|pm|acct)_/i.test(value) && !credentials.includes(value) ? value : undefined;
  return {
    ...(reference ? { reference } : {}),
    ...(typeof details?.retryable === "boolean" ? { retryable: details.retryable } : {}),
  };
}

const PROVIDER_FAILURES = new Set([
  "billing_provider_configuration_error", "billing_provider_unavailable", "billing_provider_rejected",
  "billing_storage_unavailable", "billing_database_collation_error",
]);

export class OblienBillingApi {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly billing: Oblien["billing"];

  constructor(private readonly options: {
    clientId?: string; clientSecret?: string; baseUrl?: string;
    fetch?: typeof fetch; timeoutMs?: number;
  } = {}) {
    const url = new URL(options.baseUrl ?? "https://api.oblien.com");
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      throw new Error("Oblien API URL must use HTTPS (HTTP is allowed for localhost tests)");
    }
    this.baseUrl = url.toString().replace(/\/+$/, "");
    this.fetcher = options.fetch ?? fetch;
    // The SDK has no client-wide fetch/timeout option. Replace this transport
    // so the official billing module owns endpoints and request formatting while
    // we retain timeouts, strict HTTP errors, and credential-safe redirects.
    const client = new Oblien({ token: "", baseUrl: this.baseUrl });
    client._http.request = <T>(request: Parameters<Oblien["_http"]["request"]>[0]) => this.request<T>(request);
    this.billing = client.billing;
  }

  private async request<T>({ method, path, body, query }: Parameters<Oblien["_http"]["request"]>[0]): Promise<T> {
    const meteredPricing = method === "GET" && path === "/pricing/calculator";
    if (!path.startsWith("/billing/") && !meteredPricing) throw new Error("Billing transport only accepts billing routes");
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const publicRead = meteredPricing || (method === "GET" && (path === "/billing/catalog" || path === "/billing/capacity/catalog"));
    const headers: Record<string, string> = { Accept: "application/json" };
    if (!publicRead) {
      if (!this.options.clientId || !this.options.clientSecret) {
        throw new AppError("Cloud billing is not configured", 503, "BILLING_NOT_CONFIGURED");
      }
      headers["X-Client-ID"] = this.options.clientId;
      headers["X-Client-Secret"] = this.options.clientSecret;
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    let payload: unknown;
    try {
      response = await this.fetcher(url.toString(), {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        // A redirect must never carry the reseller's credentials to another host.
        redirect: "error",
      });
      payload = await response.json();
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "platform/engine/lib/oblien-billing-api");
      throw new AppError("Cloud billing is temporarily unavailable. Please retry.", 503, "OBLIEN_BILLING_UNAVAILABLE");
    }
    if (!response.ok || (payload as { success?: unknown } | null)?.success !== true) {
      // Do not forward provider bodies: they can contain account or payment data.
      const code = providerErrorCode(payload);
      const capacityUnavailable = code === "capacity_unavailable" || code === "billing_capacity_unavailable";
      const diagnostic = providerDiagnostic(payload, [this.options.clientId, this.options.clientSecret]);
      const checkoutExpired = method === "POST" && path === "/billing/checkout" &&
        response.status === 410 && EXPIRED_CHECKOUT_CODES.has(code);
      // Oblien can return SQL failures as HTTP 400. Those are provider faults,
      // not invalid customer input; preserving 400 also hid them from API logs.
      const providerFailure = PROVIDER_FAILURES.has(code) || /^ER_[A-Z0-9_]+$/.test(code) ||
        (!checkoutExpired && ![400, 404, 409, 422, 429].includes(response.status));
      const status = providerFailure ? 503 : response.status;
      errorDiagnostics.warn("platform/engine/lib/oblien-billing-api", "[oblien:billing] Provider request failed", {
        method,
        operation: path
          .replace(/^\/billing\/policy\/[^/]+/, "/billing/policy/:namespace")
          .replace(/^\/billing\/checkout\/[^/]+/, "/billing/checkout/:checkoutId")
          .replace(/^\/billing\/subscription\/changes\/[^/]+/, "/billing/subscription/changes/:changeId"),
        providerStatus: response.status, providerCode: code,
        ...diagnostic,
      });
      const known: Record<string, string> = {
        invalid_plan: "This plan is no longer available. Refresh the plans page.",
        invalid_pack: "This credit pack is no longer available. Refresh the billing page.",
        no_customer: "No billing account exists yet. Complete a checkout first.",
        no_checkout:
          "No checkout was found for this organization. Open billing from the account that made the purchase.",
        no_subscription: "This organization has no subscription to manage.",
        subscription_ended: "This subscription has ended. Start a new checkout to subscribe again.",
        billing_customer_conflict: "This organization's billing needs to be separated from a legacy account. Contact support.",
        billing_identity_conflict: "This organization's billing identity needs to be verified. Contact support.",
        billing_redirect_not_allowed: "Cloud billing return links are not configured. Contact Openship support.",
        invalid_redirect_url: "Cloud billing requires a valid HTTPS return link. Contact Openship support.",
        billing_idempotency_conflict: "This checkout attempt no longer matches the original request. Contact Openship support before starting another payment.",
        billing_checkout_reconciliation_required: "An earlier checkout needs to be reviewed. Contact Openship support before starting another payment.",
        checkout_expired: "This checkout has expired. Choose your plan again to start a new checkout.",
        capacity_checkout_expired: "This checkout has expired. Choose your plan again to start a new checkout.",
        invalid_offer: "This Cloud offer is not configured correctly. Contact Openship support.",
        reseller_enterprise_required: "Cloud payments require an account configuration update by Openship. Contact Openship support.",
        billing_provider_configuration_error: "Cloud payments are not configured correctly. Contact Openship support.",
        billing_database_collation_error: "Cloud billing is unavailable. Contact Openship support.",
        billing_storage_unavailable: "Cloud billing is temporarily unavailable. Please try again later.",
        billing_provider_unavailable: "Cloud checkout is temporarily unavailable. Please try again later.",
        billing_provider_rejected: "Cloud checkout could not be completed. Contact Openship support.",
        billing_quote_expired: "This price quote expired. Review a fresh quote before confirming.",
        billing_quote_changed: "The subscription or price changed. Review a fresh quote before confirming.",
        idempotency_conflict: "This billing attempt no longer matches its original request. Refresh its status before trying again.",
        billing_plan_change_pending: "Finish or cancel the pending plan change first.",
        billing_change_busy: "This plan change is still being confirmed. Refresh its status; do not start another payment.",
        billing_change_not_cancelable: "This plan change can no longer be canceled. Refresh its status.",
        plan_change_not_found: "This plan change was not found for the selected server.",
        capacity_billing_unavailable: "Monthly server purchases are temporarily unavailable. Existing paid servers keep their coverage.",
        capacity_unavailable: "This server size is temporarily unavailable. Please try again later or contact support.",
        billing_capacity_unavailable: "This server size is temporarily unavailable. Please try again later or contact support.",
        billing_offer_underfunded: "Cloud pricing is not configured correctly for this server. Contact Openship support.",
        capacity_price_below_cost: "Cloud pricing is not configured correctly for this server. Contact Openship support.",
        insufficient_redeemable_balance: "Cloud server purchases are temporarily unavailable. Contact Openship support.",
      };
      const checkoutUnavailable = path === "/billing/checkout" && providerFailure;
      const message = Object.hasOwn(known, code) ? known[code]
        : checkoutUnavailable ? "Cloud checkout is temporarily unavailable. Please try again later."
          : "Cloud billing could not complete this request. Please retry.";
      throw new OperationError(diagnostic.reference ? `${message} Reference: ${diagnostic.reference}.` : message,
        status, capacityUnavailable ? "CLOUD_CAPACITY_UNAVAILABLE"
          : checkoutUnavailable ? "OBLIEN_CHECKOUT_UNAVAILABLE" : "OBLIEN_BILLING_ERROR", {
          ...(Object.hasOwn(known, code) ? { providerCode: code } : {}),
          ...(checkoutExpired ? { checkoutExpired: true } : {}),
          ...(path === "/billing/checkout" && [400, 402, 403, 409, 422].includes(response.status) && REJECTED_CHECKOUT_CODES.has(code)
            ? { checkoutRejected: true } : {}),
          ...(Object.keys(diagnostic).length ? { details: diagnostic } : {}),
        });
    }
    return payload as T;
  }

  private async validate<T>(response: Promise<unknown>, schema: z.ZodType<T>, slug?: string): Promise<T> {
    const parsed = schema.safeParse(await response);
    if (!parsed.success) throw new AppError("Cloud billing returned an invalid response", 502, "OBLIEN_BILLING_INVALID_RESPONSE");
    if (slug !== undefined && (parsed.data as { namespace?: string }).namespace !== slug) {
      throw new AppError("Cloud billing returned a different namespace", 502, "OBLIEN_BILLING_NAMESPACE_MISMATCH");
    }
    return parsed.data;
  }

  getCatalog(): Promise<OblienBillingCatalog> {
    return this.validate(this.billing.catalog(), oblienCatalogSchema);
  }

  getCapacityCatalog() {
    return this.validate(this.billing.capacityCatalog(), oblienCapacityCatalogSchema);
  }

  /** This public endpoint is not yet exposed by the SDK. Keep it on the same
   * validated, bounded transport as the SDK's billing calls. */
  getMeteredPricing() {
    return this.validate(this.request({ method: "GET", path: "/pricing/calculator" }), oblienMeteredPricingSchema);
  }

  /** Sales check only. Existing contracts and renewal keep their saved tariff. */
  async assertMonthlyCapacitySupport() {
    const catalog = await this.getCapacityCatalog();
    if (!catalog.billingModes.includes("monthly") || !catalog.paymentSources.monthly.includes("stripe"))
      throw new AppError("Monthly server purchases are temporarily unavailable", 503, "OBLIEN_CAPACITY_UNAVAILABLE");
    return catalog;
  }

  async assertResellerSupport(): Promise<void> {
    const { reseller } = await this.getCatalog();
    if (
      !reseller ||
      reseller.contractVersion < 2 ||
      !reseller.offerPolicy ||
      !reseller.resourceLimits ||
      !reseller.effectiveResourceLimits || !reseller.aggregateResourceLimits
    ) {
      throw new AppError(
        "The billing provider must enforce total namespace capacity before Cloud checkout can be enabled. Contact Openship support.",
        503,
        "OBLIEN_BILLING_UPGRADE_REQUIRED",
      );
    }
  }

  getEntitlement(slug: string): Promise<OblienEntitlement> {
    return this.validate(this.billing.entitlement(slug), oblienEntitlementSchema, slug);
  }

  getCheckout(slug: string, checkoutId: string) {
    return this.validate(
      this.billing.checkoutStatus(slug, checkoutId),
      z.object({
        success: z.literal(true),
        namespace,
        checkout: z.object({
          id: z.literal(checkoutId),
          kind: z.enum(["subscription", "topup"]),
          status: z.enum(["open", "complete", "expired"]),
          paymentStatus: z.enum(["paid", "unpaid", "no_payment_required"]),
          fulfilled: z.boolean(),
          fulfillmentStatus: z.enum([
            "pending",
            "completed",
            "partially_refunded",
            "refunded",
            "disputed",
            "expired",
            "failed",
            "superseded",
            "reversed",
          ]),
          namespaceCreditsGranted: amount.nonnegative(),
        }),
      }),
      slug,
    );
  }

  private async capacityCheckoutResponse(response: Promise<unknown>, slug: string) {
    const result = await this.validate(response, z.object({
      success: z.literal(true), namespace,
      pendingCheckout: z.object({
        quote: z.object({ id: z.string().min(1), namespace, paymentSource: z.enum(["wallet", "stripe"]) }),
        checkoutId: z.string().min(1).nullable(), url: z.url().nullable(),
      }).nullable(),
    }), slug);
    if (result.pendingCheckout) {
      if (result.pendingCheckout.quote.namespace !== slug)
        throw new AppError("Cloud billing returned a different checkout namespace", 502, "OBLIEN_BILLING_NAMESPACE_MISMATCH");
      if (result.pendingCheckout.url) this.validateCheckoutUrl(result.pendingCheckout.url);
    }
    return result;
  }

  /** The capacity contract owns reservation release and payment cancellation. */
  getPendingCapacityCheckout(slug: string) {
    return this.capacityCheckoutResponse(this.billing.capacity(slug), slug);
  }

  cancelCapacityCheckout(slug: string, input: { quoteId: string; idempotencyKey: string }) {
    return this.capacityCheckoutResponse(this.billing.cancelCapacityChange(slug, input), slug);
  }

  getBalance(slug: string) {
    return this.validate(this.billing.balance(slug), z.object({
      success: z.literal(true), namespace, blocking: z.boolean(), balance: amount.nullable(),
      billingMode: computeBillingModeSchema.optional(), computeCovered: z.boolean().optional(), paidThrough: date.optional(),
    }), slug);
  }

  getDefaults() {
    return this.validate(this.billing.defaults(), policySchema.extend({ autoApply: z.boolean() }));
  }

  getPolicy(slug: string) {
    return this.validate(this.billing.policy(slug), policySchema.extend({ namespace }), slug);
  }

  /** Mode A only: the complimentary-plan service owns these explicit grants. */
  setPolicy(slug: string, input: Pick<OblienBillingPolicy, "quotaLimit" | "overdraft" | "suspendThreshold" | "onOverdraftAction">) {
    return this.validate(this.billing.setPolicy(slug, input), policySchema.extend({ namespace }), slug);
  }

  resetQuota(slug: string, periodEnd: string) {
    return this.validate(this.billing.resetQuota(slug, { periodEnd }), z.object({
      success: z.literal(true), namespace, applied: z.boolean(),
    }), slug);
  }

  private async subscriptionResponse(response: Promise<unknown>, slug: string) {
    const result = await this.validate(response, oblienSubscriptionSchema, slug);
    if (result.subscription?.pendingChange) this.validatePlanChange(result.subscription.pendingChange, slug);
    return result;
  }

  getSubscription(slug: string) {
    return this.subscriptionResponse(this.billing.subscription(slug), slug);
  }

  cancelSubscription(slug: string) {
    return this.subscriptionResponse(this.billing.cancelSubscription(slug), slug);
  }

  resumeSubscription(slug: string) {
    return this.subscriptionResponse(this.billing.resumeSubscription(slug), slug);
  }

  async previewPlanChange(slug: string, input: OblienPlanChangeInput) {
    const request = oblienPlanChangeInputSchema.parse(input);
    const result = await this.validate(this.billing.previewPlanChange(slug, request), z.object({
      success: z.literal(true), namespace, quote: oblienPlanChangeQuoteSchema,
    }), slug);
    if (result.quote.namespace !== slug || result.quote.billingInterval !== input.billingInterval)
      throw new AppError("Cloud billing returned a different subscription quote", 502, "OBLIEN_BILLING_INVALID_RESPONSE");
    return result;
  }

  private validatePlanChange(change: OblienPlanChange, slug: string) {
    if (change.namespace !== slug)
      throw new AppError("Cloud billing returned a different namespace", 502, "OBLIEN_BILLING_NAMESPACE_MISMATCH");
    if (change.payment?.url) {
      const host = new URL(change.payment.url).hostname;
      this.validateHostedUrl(change.payment.url, host === "pay.stripe.com" ? "pay.stripe.com" : "invoice.stripe.com");
    }
  }

  private async planChangeResponse(response: Promise<unknown>, slug: string, match: { id?: string; quoteId?: string }) {
    const result = await this.validate(response, z.object({ success: z.literal(true), namespace, change: oblienPlanChangeSchema }), slug);
    this.validatePlanChange(result.change, slug);
    if ((match.id && result.change.id !== match.id) || (match.quoteId && result.change.quoteId !== match.quoteId))
      throw new AppError("Cloud billing returned a different plan change", 502, "OBLIEN_BILLING_INVALID_RESPONSE");
    return result;
  }

  changePlan(slug: string, input: { quoteId: string; idempotencyKey: string }) {
    return this.planChangeResponse(this.billing.changePlan(slug, input), slug, { quoteId: input.quoteId });
  }

  getPlanChange(slug: string, changeId: string) {
    return this.planChangeResponse(this.billing.planChange(slug, changeId), slug, { id: changeId });
  }

  cancelPlanChange(slug: string, changeId: string, idempotencyKey: string) {
    return this.planChangeResponse(this.billing.cancelPlanChange(slug, changeId, { idempotencyKey }), slug, { id: changeId });
  }

  async createPortal(input: { namespace: string; returnUrl: string }) {
    const result = await this.validate(this.billing.portal(input), portalSchema, input.namespace);
    this.validateHostedUrl(result.url, "billing.stripe.com");
    return result;
  }

  async createCheckout(input: OblienCheckout) {
    // Oblien validates admin-issued codes against the authenticated reseller
    // and this saved namespace offer before creating the Stripe session.
    const parsed = oblienCheckoutInputSchema.parse(input);
    const request = { ...parsed, allowPromotionCodes: parsed.offer?.unitAmount !== 0 };
    const result = await this.validate(this.billing.checkout(request), checkoutSchema);
    this.validateCheckoutUrl(result.url);
    return result;
  }

  private validateCheckoutUrl(value: string): void {
    const url = new URL(value);
    if (url.hostname === "api.oblien.com") {
      this.validateHostedUrl(value, "api.oblien.com");
      if (url.pathname === "/billing/pay" && !url.search && /^#[A-Za-z0-9_-]{43}$/.test(url.hash)) return;
      throw new AppError("Cloud billing returned an invalid hosted URL", 502, "OBLIEN_BILLING_INVALID_RESPONSE");
    }
    this.validateHostedUrl(value, "checkout.stripe.com");
  }

  private validateHostedUrl(value: string, hostname: string): void {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== hostname || url.port || url.username || url.password) {
      throw new AppError("Cloud billing returned an invalid hosted URL", 502, "OBLIEN_BILLING_INVALID_RESPONSE");
    }
  }
}
