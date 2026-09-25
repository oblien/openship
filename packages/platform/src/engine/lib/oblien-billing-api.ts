import { z } from "zod";
import { AppError } from "@repo/core";
import { OperationError } from "@repo/contracts";
import { Oblien } from "@repo/adapters";

// Oblien owns payments and credits. Validate its SDK responses at our tenant
// boundary before returning customer data or hosted billing session URLs.
const amount = z.number().finite();
const allowance = amount.nonnegative().nullable();
const date = z.string().refine((value) => Number.isFinite(Date.parse(value))).nullable();
const namespace = z.string().min(1).max(128);

export const oblienCatalogSchema = z.object({
  success: z.literal(true),
  reseller: z
    .object({
      contractVersion: amount.int().positive(),
      offerPolicy: z.boolean(),
      resourceLimits: z.boolean(),
      effectiveResourceLimits: z.boolean().optional(),
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

export const oblienEntitlementSchema = z.object({
  success: z.literal(true), namespace,
  tierId: z.string().nullable(),
  status: z.enum(["active", "past_due", "canceled", "credit_exhausted"]),
  periodStart: date, periodEnd: date,
  // Preserve signed legacy usage; the provider's limit includes purchased credits.
  quota: z.object({
    limit: allowance,
    used: amount,
    balance: amount.nullable(),
    overdraft: amount.nonnegative().optional(),
    suspendThreshold: allowance.optional(),
  }),
});

export const oblienOfferResourceLimitsSchema = z.object({
  max_workspaces: allowance,
  max_vcpus: allowance,
  max_ram_mb: allowance,
  max_disk_gb: allowance,
});
export const oblienOfferSchema = z.object({
  reference: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  unitAmount: amount.int().min(100).max(1_000_000),
  currency: z.literal("usd"),
  credits: amount.int().min(1).max(1_000_000_000),
  policy: z
    .object({
      overdraft: amount.int().nonnegative(),
      suspendThreshold: amount.int().nonnegative(),
      onOverdraftAction: z.enum(["block", "stop_workspaces"]),
    })
    .refine((value) => value.suspendThreshold >= value.overdraft)
    .optional(),
  resourceLimits: oblienOfferResourceLimitsSchema.optional(),
});
export type OblienOffer = z.infer<typeof oblienOfferSchema>;

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
    })
    .nullable(),
});

export type OblienBillingCatalog = z.infer<typeof oblienCatalogSchema>;
export type OblienEntitlement = z.infer<typeof oblienEntitlementSchema>;
export type OblienBillingPolicy = z.infer<typeof policySchema>;
export type OblienSubscription = z.infer<typeof oblienSubscriptionSchema>["subscription"];
/** An echoed namespace alone cannot prove a paid entitlement belongs to it. */
export function assertOblienEntitlementMatchesSubscription(entitlement: OblienEntitlement, subscription: OblienSubscription): void {
  const timestamp = (value: string | null) => value === null ? null : Date.parse(value);
  if ((entitlement.tierId ?? "free") !== (subscription?.tierId ?? "free") ||
      (!subscription && (entitlement.periodStart !== null || entitlement.periodEnd !== null)) ||
      (subscription && timestamp(subscription.periodStart) !== timestamp(entitlement.periodStart)) ||
      (subscription && timestamp(subscription.periodEnd) !== timestamp(entitlement.periodEnd)) ||
      (entitlement.status === "active" && subscription && !["active", "trialing"].includes(subscription.status))) {
    throw new AppError("Cloud billing returned an entitlement that does not match this organization's subscription", 502, "OBLIEN_ENTITLEMENT_MISMATCH");
  }
}

export type OblienCheckout = {
  namespace: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
  offer: OblienOffer;
  metadata: Record<string, string>;
} & ({ kind: "subscription"; billingInterval: "monthly" | "yearly" } | { kind: "topup" });

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
    // SDK 2.4 has no client-wide fetch/timeout option. Replace this transport
    // so the official billing module owns endpoints and request formatting while
    // we retain timeouts, strict HTTP errors, and credential-safe redirects.
    const client = new Oblien({ token: "", baseUrl: this.baseUrl });
    client._http.request = <T>(request: Parameters<Oblien["_http"]["request"]>[0]) => this.request<T>(request);
    this.billing = client.billing;
  }

  private async request<T>({ method, path, body, query }: Parameters<Oblien["_http"]["request"]>[0]): Promise<T> {
    if (!path.startsWith("/billing/")) throw new Error("Billing transport only accepts billing routes");
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const publicRead = method === "GET" && path === "/billing/catalog";
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
    } catch {
      throw new AppError("Cloud billing is temporarily unavailable. Please retry.", 503, "OBLIEN_BILLING_UNAVAILABLE");
    }
    if (!response.ok || (payload as { success?: unknown } | null)?.success !== true) {
      // Do not forward provider bodies: they can contain account or payment data.
      const code = providerErrorCode(payload);
      const diagnostic = providerDiagnostic(payload, [this.options.clientId, this.options.clientSecret]);
      // Oblien can return SQL failures as HTTP 400. Those are provider faults,
      // not invalid customer input; preserving 400 also hid them from API logs.
      const providerFailure = PROVIDER_FAILURES.has(code) || /^ER_[A-Z0-9_]+$/.test(code) || ![400, 404, 409, 422, 429].includes(response.status);
      const status = providerFailure ? 503 : response.status;
      console.warn("[oblien:billing] Provider request failed", {
        method,
        operation: path
          .replace(/^\/billing\/policy\/[^/]+/, "/billing/policy/:namespace")
          .replace(/^\/billing\/checkout\/[^/]+/, "/billing/checkout/:checkoutId"),
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
        billing_idempotency_conflict: "This checkout attempt no longer matches the original request. Contact Openship support before starting another payment.",
        billing_checkout_reconciliation_required: "An earlier checkout needs to be reviewed. Contact Openship support before starting another payment.",
        invalid_offer: "This Cloud offer is not configured correctly. Contact Openship support.",
        reseller_enterprise_required: "Cloud payments require an account configuration update by Openship. Contact Openship support.",
        billing_provider_configuration_error: "Cloud payments are not configured correctly. Contact Openship support.",
        billing_database_collation_error: "Cloud billing is unavailable. Contact Openship support.",
        billing_storage_unavailable: "Cloud billing is temporarily unavailable. Please try again later.",
        billing_provider_unavailable: "Cloud checkout is temporarily unavailable. Please try again later.",
        billing_provider_rejected: "Cloud checkout could not be completed. Contact Openship support.",
      };
      const checkoutUnavailable = path === "/billing/checkout" && providerFailure;
      const message = Object.hasOwn(known, code) ? known[code]
        : checkoutUnavailable ? "Cloud checkout is temporarily unavailable. Please try again later."
          : "Cloud billing could not complete this request. Please retry.";
      throw new OperationError(diagnostic.reference ? `${message} Reference: ${diagnostic.reference}.` : message,
        status, checkoutUnavailable ? "OBLIEN_CHECKOUT_UNAVAILABLE" : "OBLIEN_BILLING_ERROR", {
          ...(Object.hasOwn(known, code) ? { providerCode: code } : {}),
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

  async assertResellerSupport(): Promise<void> {
    const { reseller } = await this.getCatalog();
    if (
      !reseller ||
      reseller.contractVersion < 2 ||
      !reseller.offerPolicy ||
      !reseller.resourceLimits ||
      !reseller.effectiveResourceLimits
    ) {
      throw new AppError(
        "The billing provider needs the namespace capacity policy update before Cloud checkout can be enabled.",
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
          ]),
          namespaceCreditsGranted: amount.nonnegative(),
        }),
      }),
      slug,
    );
  }

  getBalance(slug: string) {
    return this.validate(this.billing.balance(slug), z.object({
      success: z.literal(true), namespace, blocking: z.boolean(), balance: amount.nullable(),
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

  getSubscription(slug: string) {
    return this.validate(this.billing.subscription(slug), oblienSubscriptionSchema, slug);
  }

  cancelSubscription(slug: string) {
    return this.validate(this.billing.cancelSubscription(slug), oblienSubscriptionSchema, slug);
  }

  resumeSubscription(slug: string) {
    return this.validate(this.billing.resumeSubscription(slug), oblienSubscriptionSchema, slug);
  }

  async createPortal(input: { namespace: string; returnUrl: string }) {
    const result = await this.validate(this.billing.portal(input), portalSchema, input.namespace);
    this.validateHostedUrl(result.url, "billing.stripe.com");
    return result;
  }

  async createCheckout(input: OblienCheckout) {
    const result = await this.validate(this.billing.checkout(input), checkoutSchema);
    this.validateHostedUrl(result.url, "checkout.stripe.com");
    return result;
  }

  private validateHostedUrl(value: string, hostname: string): void {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== hostname || url.port || url.username || url.password) {
      throw new AppError("Cloud billing returned an invalid hosted URL", 502, "OBLIEN_BILLING_INVALID_RESPONSE");
    }
  }
}
