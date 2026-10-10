import { createHash } from "node:crypto";
import { AppError, NotFoundError, PRICING, generateId, ACTIONS_UNITS_PER_CENT } from "@repo/core";
import type { Repositories } from "@repo/db/factory";
import type { OblienBillingApi, OblienCheckout } from "../../lib/oblien-billing-api";

interface ActionCreditPorts {
  repo: Repositories["actionBilling"];
  provider: Pick<OblienBillingApi, "createCheckout" | "getCheckout">;
  prepareNamespace(organizationId: string): Promise<void>;
  prepareRunners(organizationId: string): Promise<void>;
  lock<T>(organizationId: string, operation: () => Promise<T>): Promise<T>;
  encrypt(value: string): string;
  decrypt(value: string): string;
  dashboardUrl: string;
}

type Purchase = NonNullable<Awaited<ReturnType<Repositories["actionBilling"]["purchase"]>>>;
type PaymentEvent = Parameters<Repositories["actionBilling"]["queuePurchaseChecks"]>[1];

export function actionBillingNamespace(organizationId: string): string {
  return `osa-${createHash("sha256").update(organizationId).digest("hex").slice(0, 40)}`;
}

/** Oblien owns payment settlement. This service records the purchased retail
 * Actions budget, without touching app-server subscriptions or owner credits. */
export class ActionCredits {
  constructor(private readonly ports: ActionCreditPorts) {}

  async checkout(organizationId: string, amountCents: number, key: string) {
    if (!PRICING.actions.depositsCents.includes(amountCents))
      throw new AppError("Choose an available Actions deposit", 400, "ACTIONS_DEPOSIT_INVALID");
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key))
      throw new AppError(
        "A payment idempotency key is required",
        400,
        "ACTIONS_CHECKOUT_KEY_REQUIRED",
      );
    return this.ports.lock(organizationId, async () => {
      const namespace = actionBillingNamespace(organizationId);
      const id = generateId("acredit");
      const dashboard = this.ports.dashboardUrl.replace(/\/$/, "");
      const request: OblienCheckout = {
        namespace,
        kind: "topup",
        idempotencyKey: `openship-actions:${id}`,
        offer: {
          reference: `actions-deposit-v${PRICING.actions.version}-${amountCents}`,
          name: "Openship Actions funds",
          description: "Prepaid Actions budget. Separate from managed server subscriptions.",
          unitAmount: amountCents,
          currency: "usd",
          credits: amountCents,
        },
        metadata: {
          product: "openship-actions",
          organizationId,
          orderId: id,
          priceVersion: String(PRICING.actions.version),
        },
        successUrl: `${dashboard}/actions/billing?purchase=${encodeURIComponent(id)}`,
        cancelUrl: `${dashboard}/actions/billing?purchase=${encodeURIComponent(id)}&cancelled=1`,
      };
      const purchase = await this.ports.repo.createPurchase(
        { id, organizationId, idempotencyKey: key, priceCents: amountCents, request },
        namespace,
      );
      return this.open(organizationId, purchase.id);
    });
  }

  async resume(organizationId: string, id: string) {
    return this.ports.lock(organizationId, () => this.open(organizationId, id));
  }

  private async open(organizationId: string, id: string) {
    const purchase = await this.ports.repo.purchase(organizationId, id);
    if (!purchase) throw new NotFoundError("Actions payment", id);
    if (purchase.checkoutId) {
      const verified = await this.inspectUnlocked(organizationId, id);
      if (verified.status !== "open") return { purchaseId: id, checkoutUrl: null };
      if (purchase.checkoutUrlEnc)
        return { purchaseId: id, checkoutUrl: this.ports.decrypt(purchase.checkoutUrlEnc) };
    }
    return this.restoreCheckout(purchase);
  }

  private async restoreCheckout(purchase: Purchase) {
    // Replaying the persisted request reconciles a lost checkout response. No
    // changed price, metadata, return URL or newly generated key is substituted.
    const request = purchase.request as OblienCheckout;
    if (
      request.namespace !== actionBillingNamespace(purchase.organizationId) ||
      request.kind !== "topup"
    )
      throw new AppError(
        "Actions payment ownership could not be verified",
        409,
        "ACTIONS_CHECKOUT_CONFLICT",
      );
    await this.ports.prepareNamespace(purchase.organizationId);
    const result = await this.ports.provider.createCheckout(request);
    await this.ports.repo.recordCheckout(
      purchase.organizationId,
      purchase.id,
      result.checkoutId,
      this.ports.encrypt(result.url),
    );
    return { purchaseId: purchase.id, checkoutUrl: result.url };
  }

  async queuePaymentCheck(organizationId: string, event: PaymentEvent) {
    return this.ports.lock(organizationId, () =>
      this.ports.repo.queuePurchaseChecks(organizationId, event),
    );
  }

  /** Background recovery may replay an existing intent after a lost response;
   * the public read path below never opens a checkout. */
  async recoverDuePurchase(organizationId: string, id: string) {
    return this.ports.lock(organizationId, async () => {
      const purchase = await this.ports.repo.beginPurchaseCheck(organizationId, id);
      if (!purchase) return false;
      if (!purchase.checkoutId) await this.restoreCheckout(purchase);
      await this.inspectUnlocked(organizationId, id, true);
      return true;
    });
  }

  async inspect(organizationId: string, id: string) {
    // The provider read and local checkpoint share one distributed lock.
    // Otherwise a slow older read could re-grant a just-refunded payment.
    return this.ports.lock(organizationId, () => this.inspectUnlocked(organizationId, id));
  }

  private async inspectUnlocked(organizationId: string, id: string, prepareRunners = false) {
    const purchase = await this.ports.repo.purchase(organizationId, id);
    if (!purchase) throw new NotFoundError("Actions payment", id);
    if (!purchase.checkoutId) return purchase;
    const namespace = actionBillingNamespace(organizationId);
    const response = await this.ports.provider.getCheckout(namespace, purchase.checkoutId);
    const checkout = response.checkout;
    if (
      response.namespace !== namespace ||
      checkout.id !== purchase.checkoutId ||
      checkout.kind !== "topup"
    )
      throw new AppError(
        "Actions payment ownership could not be verified",
        502,
        "ACTIONS_PAYMENT_IDENTITY_MISMATCH",
      );
    const paid =
      checkout.fulfilled &&
      checkout.status === "complete" &&
      ["paid", "no_payment_required"].includes(checkout.paymentStatus);
    const funded = paid && ["completed", "partially_refunded"].includes(checkout.fulfillmentStatus);
    const net = funded ? checkout.namespaceCreditsGranted : 0;
    if (!Number.isFinite(net) || net < 0 || net > purchase.priceCents)
      throw new AppError(
        "Actions payment amount could not be verified",
        502,
        "ACTIONS_PAYMENT_AMOUNT_MISMATCH",
      );
    const status =
      checkout.status === "expired"
        ? "expired"
        : checkout.status === "open"
          ? "open"
          : checkout.fulfilled || checkout.fulfillmentStatus === "failed"
            ? checkout.fulfillmentStatus
            : "processing";
    const budget = await this.ports.repo.budget(organizationId);
    const needsSetup = net > 0 && (budget?.runnerVersion ?? 0) < PRICING.actions.version;
    // Provider credit grants are cents at this offer's saved 1:1 conversion.
    // Floor sub-unit refunds conservatively; never round an allowance upward.
    const saved = await this.ports.repo.reconcilePurchase(
      organizationId,
      id,
      purchase.checkoutId,
      Math.floor(net * ACTIONS_UNITS_PER_CENT),
      status,
      // Fulfilled receipts remain auditable after refund/dispute events are
      // missed. Pending fulfillment is revisited promptly without a browser.
      status === "expired"
        ? null
        : status === "open"
          ? 300
          : status === "processing" || needsSetup
            ? 60
            : 86_400,
    );
    if (!needsSetup || !prepareRunners) return saved;
    // Confirm funds BEFORE setup. A failed capacity update must never hide a
    // completed payment. The receipt's short recheck survives process loss.
    try {
      await this.ports.prepareRunners(organizationId);
      await this.ports.repo.markRunnersReady(organizationId, PRICING.actions.version);
    } catch (error) {
      await this.ports.repo.recordRunnerSetupFailure(organizationId);
      throw error;
    }
    // The absolute receipt is unchanged; only its next audit moves to daily.
    return this.ports.repo.reconcilePurchase(
      organizationId,
      id,
      purchase.checkoutId,
      saved.fundedUnits,
      status,
      86_400,
    );
  }
}
