/** Read-only release checks. Does not create tokens, checkouts, or resources. */
import { runtimeTarget } from "@repo/core";
import { assertOblienEntitlementMatchesSubscription, OblienBillingApi } from "@repo/platform/engine/lib/oblien-billing-api";
import { OBLIEN_WEBHOOK_EVENTS, oblienWebhookUrl } from "@repo/platform/engine/lib/oblien-webhook-config";

const results: Array<{ check: string; ok: boolean; skipped?: boolean; detail?: string }> = [];
const record = (check: string, ok: boolean, detail?: string) => results.push({ check, ok, ...(detail ? { detail } : {}) });
const clientId = process.env.OBLIEN_CLIENT_ID;
const clientSecret = process.env.OBLIEN_CLIENT_SECRET;
const apiBase = process.env.OBLIEN_API_URL ?? "https://api.oblien.com";
record("Cloud mode", process.env.CLOUD_MODE === "true");
record("Oblien credentials configured", Boolean(clientId && clientSecret));
record("Webhook secret configured", Boolean(process.env.OBLIEN_WEBHOOK_SECRET));
record("Subscription purchases enabled", process.env.BILLING_ENABLED === "true");
record("Credit purchases enabled", process.env.BILLING_TOPUPS_ENABLED === "true");

const billing = new OblienBillingApi({ clientId, clientSecret, baseUrl: apiBase });
const checks = await Promise.allSettled([
  (async () => {
    const catalog = await billing.getCatalog();
    const plans = catalog.plans.filter((plan) => plan.priceMonthly !== null);
    record("Provider catalog", plans.length > 0 && [...catalog.plans, ...catalog.creditPacks].every((item) => item.currency.toUpperCase() === "USD"),
      `${plans.length} priced plans, ${catalog.creditPacks.length} credit packs`);
  })(),
  (async () => {
    const defaults = await billing.getDefaults();
    record("Zero-credit automatic namespace policy", defaults.autoApply && defaults.quotaLimit === 0 && defaults.overdraft === 0 && defaults.suspendThreshold === 0 && defaults.onOverdraftAction === "stop_workspaces",
      `autoApply=${defaults.autoApply}, quotaLimit=${defaults.quotaLimit}, overdraft=${defaults.overdraft}, suspendThreshold=${defaults.suspendThreshold}, action=${defaults.onOverdraftAction}`);
  })(),
  (async () => {
    const callback = oblienWebhookUrl(process.env.OBLIEN_WEBHOOK_URL, runtimeTarget.api);
    if (!clientId || !clientSecret) throw new Error("Oblien credentials are missing");
    const response = await fetch(`${apiBase.replace(/\/+$/, "")}/webhooks`, {
      headers: { "X-Client-ID": clientId, "X-Client-Secret": clientSecret },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Webhook registry HTTP ${response.status}`);
    const body = await response.json() as { success: boolean; webhooks?: Array<{ url: string; active: boolean; namespace?: string | null; events: string[]; secret?: string | null }> };
    const webhook = body.success && body.webhooks?.find((item) => item.url === callback && !item.namespace && item.active);
    const missing = OBLIEN_WEBHOOK_EVENTS.filter((event) => !webhook || !webhook.events.includes(event));
    const maskedSecret = typeof webhook?.secret === "string" && /^[*•＊…]+$/u.test(webhook.secret);
    const matchingSecret = Boolean(webhook?.secret && webhook.secret === process.env.OBLIEN_WEBHOOK_SECRET);
    record("Account-wide signed billing webhook", Boolean(webhook && (maskedSecret || matchingSecret) && missing.length === 0),
      !webhook ? "No active account-wide webhook matches the configured callback"
        : !maskedSecret && !matchingSecret ? "The registered signing secret does not match the API environment"
          : `Missing events: ${missing.join(", ") || "none"}`);
    if (maskedSecret) {
      results.push({ check: "Webhook signing secret match", ok: true, skipped: true,
        detail: "Oblien masks the registered secret. Confirm a signed delivery reaches the deployed API; registry inspection cannot compare secrets." });
    }
  })(),
  (async () => {
    if (!clientId || !clientSecret) throw new Error("Oblien credentials are missing");
    const response = await fetch(`${apiBase.replace(/\/+$/, "")}/namespaces?limit=1`, {
      headers: { "X-Client-ID": clientId, "X-Client-Secret": clientSecret },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Namespace registry HTTP ${response.status}`);
    const body = await response.json() as { success: boolean; data?: Array<{ slug: string }> };
    if (!body.success || !Array.isArray(body.data)) throw new Error("Invalid namespace registry response");
    const namespace = body.data[0]?.slug;
    if (!namespace) {
      // A nonexistent namespace has no policy. Treating that fabricated name
      // as a customer incorrectly reports unlimited credit on a fresh account.
      // The automatic default policy is checked independently above.
      results.push({ check: "Customer namespace checks", ok: true, skipped: true,
        detail: "No namespaces exist yet. Re-run after the first customer opens billing to verify their allowance and subscription." });
      return;
    }
    const [state, entitlement] = await Promise.all([billing.getSubscription(namespace), billing.getEntitlement(namespace)]);
    assertOblienEntitlementMatchesSubscription(entitlement, state.subscription);
    record("Namespace entitlement and subscription", true, "The namespace's tier and billing period agree");
    record("Finite namespace allowance", entitlement.quota.limit !== null || entitlement.tierId === "enterprise",
      "Consumer namespaces must not inherit unlimited account-owner credit");
  })(),
]);
checks.forEach((result, index) => {
  if (result.status === "rejected") {
    // Never serialize provider bodies, headers, credentials, or webhook secrets.
    const error = result.reason;
    record(["Provider catalog", "Namespace default policy", "Webhook registration", "Namespace entitlement and subscription"][index]!, false,
      error instanceof Error ? error.message : "Read failed");
  }
});
console.log(JSON.stringify({ readOnly: true, checks: results, passed: results.every((result) => result.ok) }, null, 2));
process.exitCode = results.every((result) => result.ok) ? 0 : 1;
