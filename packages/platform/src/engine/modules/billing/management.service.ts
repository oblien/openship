import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AppError, PRICING } from "@repo/core";
import { repos } from "@repo/db";
import { OperationError, type ManagementPurchase, type ManagementState } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { env, runtimeTarget } from "../../config/env";
import { getOblienBillingApi } from "../../lib/oblien-client";
import {
  oblienCheckoutInputSchema,
  oblienPlanChangeInputSchema,
} from "../../lib/oblien-billing-api";
import { ensureCloudNamespace } from "../../lib/oblien-namespace";
import { createProvisionLock } from "../../lib/provision-lock";
import { withServerInventoryLock } from "../../lib/server-inventory-lock";
import { isExpiredCheckout } from "./workspace-checkout";
import {
  managementOffer,
  managementPlan,
  managementCloudBenefitOffer,
  managementTerms,
  managementSubscription,
  managementServerLimit,
  paidManagement,
  parseManagementTerms,
} from "./management-contract";

const ACCESS_REFRESH_MS = 60_000;
const lock = <T>(org: string, work: () => Promise<T>) =>
  createProvisionLock(`management-billing:${org}`).run(work);
const billingUrl = () => `${runtimeTarget.dashboard}/billing/manage`;
export const managementNamespace = (org: string) =>
  `os-manage-${createHash("sha256").update(org).digest("hex").slice(0, 32)}`;
const key = (org: string, value: string) =>
  `manage:${createHash("sha256").update(`${org}:${value}`).digest("hex")}`;
const unfinished = (status: string) =>
  !["applied", "canceled", "expired", "failed"].includes(status);
const connected = async (org: string) =>
  (await repos.server.listByOrganization(org, true)).filter(
    (server) => !server.workspaceId && !server.isLocal && server.purpose !== "migration_source",
  );
type Account = NonNullable<Awaited<ReturnType<typeof repos.managementBilling.get>>>;

function assertCloud() {
  if (!env.CLOUD_MODE)
    throw new AppError(
      "Hosted management billing belongs to Openship Cloud",
      404,
      "CAPABILITY_UNAVAILABLE",
    );
}

/** Provider-backed Cloud coverage, including legacy paid subscriptions. A paid
 * sibling is sufficient; an unavailable provider is never treated as cancellation. */
async function cloudCoverage(org: string): Promise<Date | null> {
  if (!PRICING.management.includedWithCloud) return null;
  const [organization, workspaces] = await Promise.all([
    repos.organization.findById(org),
    repos.cloudWorkspace.listByOrganization(org),
  ]);
  const namespaces = new Set(
    [
      organization?.oblienNamespace,
      ...workspaces
        .filter((row) => !row.remote && !row.deletionInProgress)
        .map((row) => row.namespace),
    ].filter((value): value is string => !!value),
  );
  const results = await Promise.allSettled(
    [...namespaces].map((namespace) => getOblienBillingApi().getEntitlement(namespace)),
  );
  let end = 0;
  for (const result of results)
    if (
      result.status === "fulfilled" &&
      result.value.tierId !== "free" &&
      result.value.billingMode !== "service" &&
      result.value.status === "active"
    )
      end = Math.max(end, Date.parse(result.value.periodEnd ?? "") || 0);
  if (end > Date.now()) return new Date(end);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return null;
}

async function account(org: string) {
  assertCloud();
  await repos.managementBilling.ensure(org, managementNamespace(org));
  const row = await repos.managementBilling.get(org);
  if (!row || row.namespace !== managementNamespace(org))
    throw new AppError(
      "Management billing ownership could not be verified",
      409,
      "MANAGEMENT_BILLING_MISMATCH",
    );
  return row;
}

async function checkoutRequest(row: Account) {
  if (!row.checkout)
    throw new AppError("No Manage checkout is pending", 404, "MANAGEMENT_CHECKOUT_NOT_PENDING");
  const request = oblienCheckoutInputSchema.parse(row.checkout.request);
  if (
    request.namespace !== row.namespace ||
    request.kind !== "subscription" ||
    request.metadata?.openship_organization !== row.organizationId ||
    request.offer?.billingMode !== "service"
  )
    throw new AppError(
      "Management checkout ownership changed",
      409,
      "MANAGEMENT_CHECKOUT_CONFLICT",
    );
  return request;
}

/** Retry the immutable saved request after a lost response. It cannot create a
 * different payment or discard a checkout whose payment is still settling. */
async function recoverCheckout(row: Account) {
  if (!row.checkout) return;
  const api = getOblienBillingApi();
  if (!row.checkout.id) {
    let created;
    try {
      created = await api.createCheckout(await checkoutRequest(row));
    } catch (error) {
      if (!isExpiredCheckout(error)) throw error;
      // Provider confirms this exact checkout expired; a network failure never clears it.
      await repos.managementBilling.update(row.organizationId, { checkout: null });
      row.checkout = null;
      return;
    }
    row.checkout = { ...row.checkout, id: created.checkoutId };
    await repos.managementBilling.update(row.organizationId, { checkout: row.checkout });
  }
  const { checkout } = row.checkout.canceling
    ? await api.cancelCheckout(row.namespace, row.checkout.id!, {
        idempotencyKey: key(row.organizationId, `cancel:${row.checkout.id}`),
      })
    : await api.getCheckout(row.namespace, row.checkout.id!);
  if (checkout.status === "expired" || (checkout.status === "complete" && checkout.fulfilled)) {
    await repos.managementBilling.update(row.organizationId, { checkout: null });
    row.checkout = null;
  }
}

async function refresh(org: string) {
  const row = await account(org);
  const api = getOblienBillingApi();
  if (row.namespaceReady) await recoverCheckout(row);
  const [{ subscription }, entitlement, cloudCoveredUntil] = await Promise.all([
    row.namespaceReady
      ? api.getSubscription(row.namespace)
      : Promise.resolve({ subscription: null }),
    row.namespaceReady ? api.getEntitlement(row.namespace) : Promise.resolve(null),
    cloudCoverage(org),
  ]);
  const paid = entitlement ? paidManagement(org, row.namespace, subscription, entitlement) : null;
  if (
    paid &&
    subscription?.pendingChange?.status === "scheduled" &&
    row.change?.quoteId === subscription.pendingChange.quoteId
  ) {
    const next = oblienPlanChangeInputSchema.parse(row.change.request);
    if (!isDeepStrictEqual(next.offer, subscription.pendingChange.next))
      throw new AppError("The pending Manage allowance changed", 409, "MANAGEMENT_QUOTE_CHANGED");
    Object.assign(paid, {
      newServerLimit: Math.min(
        paid.servers,
        parseManagementTerms(next.metadata.openship_management).servers,
      ),
    });
  }
  const checkedAt = new Date();
  await repos.managementBilling.update(org, { verified: paid, cloudCoveredUntil, checkedAt });
  return { row: { ...row, verified: paid, cloudCoveredUntil, checkedAt }, subscription, paid };
}

async function state(org: string): Promise<ManagementState> {
  const [{ row, subscription }, servers, catalog] = await Promise.all([
    refresh(org),
    connected(org),
    getOblienBillingApi().getCatalog(),
  ]);
  const serverLimit = managementServerLimit(row.verified, row.cloudCoveredUntil);
  return {
    pricing: PRICING.management,
    purchasesAvailable: env.BILLING_ENABLED && catalog.reseller?.serviceOffers === true,
    cloudIncluded: (row.cloudCoveredUntil?.getTime() ?? 0) > Date.now(),
    active: serverLimit > 0,
    support: serverLimit > 0 ? row.verified?.plan === "priority" ? "priority" : "email" : null,
    serverLimit,
    connectedServers: servers.length,
    pendingCheckout: !!row.checkout,
    subscription: managementSubscription(org, row.namespace, subscription),
    change:
      subscription?.pendingChange && unfinished(subscription.pendingChange.status)
        ? {
            status: subscription.pendingChange.status,
            effectiveAt: subscription.pendingChange.effectiveAt,
            paymentUrl: subscription.pendingChange.payment?.url ?? null,
          }
        : null,
  };
}

export async function getManagement(ctx: ExecutionContext) {
  assertCloud();
  return lock(ctx.organizationId, () => state(ctx.organizationId));
}

async function assertSales() {
  if (
    !env.BILLING_ENABLED ||
    (await getOblienBillingApi().getCatalog()).reseller?.serviceOffers !== true
  )
    throw new AppError(
      "Manage checkout is not enabled yet",
      503,
      "MANAGEMENT_CHECKOUT_UNAVAILABLE",
    );
}
async function assertServerCount(org: string, count: number) {
  if ((await connected(org)).length > count)
    throw new AppError(
      "Disconnect the servers you no longer want to manage before reducing this allowance",
      409,
      "MANAGEMENT_SERVERS_IN_USE",
    );
}

export async function purchaseManagement(ctx: ExecutionContext, input: ManagementPurchase) {
  assertCloud();
  const org = ctx.organizationId;
  return withServerInventoryLock(org, () =>
    lock(org, async () => {
      await assertSales();
      await assertServerCount(org, input.servers);
      let owner = await account(org);
      if (!owner.namespaceReady) {
        await ensureCloudNamespace({
          name: "Openship Manage",
          slug: owner.namespace,
          resource_limits: {
            max_workspaces: 0,
            max_vcpus: 0,
            max_ram_mb: 0,
            max_disk_gb: 0,
            max_total_vcpus: 0,
            max_total_ram_mb: 0,
            max_total_disk_gb: 0,
          },
        });
        await repos.managementBilling.update(org, { namespaceReady: true });
        owner = { ...owner, namespaceReady: true };
      }
      const { row, subscription } = await refresh(org);
      const savedTerms = managementTerms(org, owner.namespace, subscription);
      const selected = managementOffer(org, owner.namespace, input.servers,
        (row.cloudCoveredUntil?.getTime() ?? 0) > Date.now(),
        input.plan ?? (savedTerms ? managementPlan(savedTerms) : "basic"));
      const api = getOblienBillingApi();
      if (subscription && subscription.status !== "canceled") {
        managementTerms(org, owner.namespace, subscription);
        if (subscription.pendingChange && unfinished(subscription.pendingChange.status))
          throw new AppError(
            "Finish or cancel the pending subscription change first",
            409,
            "BILLING_PLAN_CHANGE_PENDING",
          );
        if (subscription.cancelAtPeriodEnd)
          throw new AppError(
            "Resume your subscription before changing its allowance",
            409,
            "MANAGEMENT_RENEWAL_CANCELED",
          );
        const request = {
          ...selected,
          billingInterval: "monthly" as const,
          idempotencyKey: key(org, input.idempotencyKey),
        };
        const { quote } = await api.previewPlanChange(owner.namespace, request);
        if (!isDeepStrictEqual(quote.next, selected.offer))
          throw new AppError("Management quote changed", 409, "MANAGEMENT_QUOTE_CHANGED");
        await repos.managementBilling.update(org, {
          change: { quoteId: quote.id, request, confirmationKey: key(org, `confirm:${quote.id}`) },
        });
        return {
          kind: "quote" as const,
          url: null,
          quoteId: quote.id,
          amountDueNow: quote.amountDueNow,
          monthlyCents: selected.offer.unitAmount,
          effectiveAt: quote.effectiveAt,
        };
      }
      const request = {
        ...selected,
        namespace: owner.namespace,
        kind: "subscription" as const,
        billingInterval: "monthly" as const,
        idempotencyKey: key(org, input.idempotencyKey),
        successUrl: `${billingUrl()}?checkout=success`,
        cancelUrl: `${billingUrl()}?checkout=cancelled`,
      };
      if (row.checkout && !isDeepStrictEqual(row.checkout.request, request))
        throw new AppError(
          "Resume or cancel the saved Manage checkout before selecting another plan",
          409,
          "MANAGEMENT_CHECKOUT_PENDING",
        );
      await repos.managementBilling.update(org, {
        checkout: { request, ...(row.checkout?.id ? { id: row.checkout.id } : {}) },
      });
      let result;
      try {
        result = await api.createCheckout(request);
      } catch (error) {
        // Release a fresh request only on a confirmed provider refusal. An
        // uncertain earlier attempt must stay recoverable under the same key.
        if (
          isExpiredCheckout(error) ||
          (!row.checkout &&
            error instanceof OperationError &&
            error.details?.checkoutRejected === true)
        )
          await repos.managementBilling.update(org, { checkout: null });
        throw error;
      }
      if (row.checkout?.id && result.checkoutId !== row.checkout.id)
        throw new AppError("Checkout identity changed", 502, "MANAGEMENT_CHECKOUT_CONFLICT");
      await repos.managementBilling.update(org, { checkout: { request, id: result.checkoutId } });
      return {
        kind: "checkout" as const,
        url: result.url,
        quoteId: null,
        amountDueNow: null,
        monthlyCents: selected.offer.unitAmount,
        effectiveAt: null,
      };
    }),
  );
}

export async function confirmManagementChange(ctx: ExecutionContext, input: { quoteId: string }) {
  return withServerInventoryLock(ctx.organizationId, () =>
    lock(ctx.organizationId, async () => {
      await assertSales();
      const row = await account(ctx.organizationId);
      if (row.change?.quoteId !== input.quoteId)
        throw new AppError(
          "Review a current Manage quote before confirming",
          409,
          "MANAGEMENT_QUOTE_REQUIRED",
        );
      const request = oblienPlanChangeInputSchema.parse(row.change.request);
      const terms = parseManagementTerms(request.metadata.openship_management);
      await assertServerCount(ctx.organizationId, terms.servers);
      if (
        !isDeepStrictEqual(request, {
          ...managementOffer(
            ctx.organizationId,
            row.namespace,
            terms.servers,
            !!(await cloudCoverage(ctx.organizationId)),
            managementPlan(terms),
          ),
          billingInterval: "monthly",
          idempotencyKey: request.idempotencyKey,
        })
      )
        throw new AppError(
          "Your Cloud coverage changed. Review a new quote before paying.",
          409,
          "MANAGEMENT_QUOTE_CHANGED",
        );
      const result = await getOblienBillingApi().changePlan(row.namespace, {
        quoteId: input.quoteId,
        idempotencyKey: row.change.confirmationKey,
      });
      await repos.managementBilling.update(ctx.organizationId, {
        change: { ...row.change, id: result.change.id },
        checkedAt: null,
      });
      return state(ctx.organizationId);
    }),
  );
}

export async function cancelManagementChange(ctx: ExecutionContext) {
  return lock(ctx.organizationId, async () => {
    const row = await account(ctx.organizationId);
    if (row.namespaceReady) {
      const api = getOblienBillingApi();
      const { subscription } = await api.getSubscription(row.namespace);
      managementTerms(ctx.organizationId, row.namespace, subscription);
      const pending = subscription?.pendingChange;
      if (pending && unfinished(pending.status))
        await api.cancelPlanChange(
          row.namespace,
          pending.id,
          key(ctx.organizationId, `cancel-change:${pending.id}`),
        );
    }
    return state(ctx.organizationId);
  });
}

export async function resumeManagementCheckout(ctx: ExecutionContext) {
  return lock(ctx.organizationId, async () => {
    const row = await account(ctx.organizationId);
    await recoverCheckout(row);
    if (!row.checkout) return { url: null };
    if (row.checkout.canceling)
      throw new AppError(
        "Checkout cancellation is still pending",
        409,
        "MANAGEMENT_CHECKOUT_PENDING",
      );
    const api = getOblienBillingApi();
    const { checkout } = await api.getCheckout(row.namespace, row.checkout.id!);
    if (checkout.status !== "open") return { url: null };
    const created = await api.createCheckout(await checkoutRequest(row));
    if (created.checkoutId !== row.checkout.id)
      throw new AppError("Checkout identity changed", 502, "MANAGEMENT_CHECKOUT_CONFLICT");
    return { url: created.url };
  });
}
export async function cancelManagementCheckout(ctx: ExecutionContext) {
  return lock(ctx.organizationId, async () => {
    const row = await account(ctx.organizationId);
    if (row.checkout)
      await repos.managementBilling.update(ctx.organizationId, {
        checkout: { ...row.checkout, canceling: true },
      });
    return state(ctx.organizationId);
  });
}
async function renewal(ctx: ExecutionContext, resume: boolean) {
  return lock(ctx.organizationId, async () => {
    const row = await account(ctx.organizationId);
    const api = getOblienBillingApi();
    if (!row.namespaceReady)
      throw new AppError("No Manage subscription exists", 404, "MANAGEMENT_SUBSCRIPTION_NOT_FOUND");
    const { subscription } = await api.getSubscription(row.namespace);
    const terms = managementTerms(ctx.organizationId, row.namespace, subscription);
    if (!terms)
      throw new AppError("No Manage subscription exists", 404, "MANAGEMENT_SUBSCRIPTION_NOT_FOUND");
    if (resume && terms.baseIncluded !== !!(await cloudCoverage(ctx.organizationId)))
      throw new AppError(
        "Your Cloud coverage changed. Review the current Manage price before renewing.",
        409,
        "MANAGEMENT_COVERAGE_CHANGED",
      );
    const result = resume
      ? await api.resumeSubscription(row.namespace)
      : await api.cancelSubscription(row.namespace);
    managementTerms(ctx.organizationId, row.namespace, result.subscription);
    if (!result.subscription || result.subscription.cancelAtPeriodEnd === resume)
      throw new AppError(
        "The provider has not confirmed this renewal change",
        502,
        "MANAGEMENT_BILLING_MISMATCH",
      );
    return state(ctx.organizationId);
  });
}
export const cancelManagementSubscription = (ctx: ExecutionContext) => renewal(ctx, false);
export const resumeManagementSubscription = (ctx: ExecutionContext) => renewal(ctx, true);
export async function createManagementPortal(ctx: ExecutionContext) {
  const row = await account(ctx.organizationId);
  if (!row.namespaceReady)
    throw new AppError(
      "No Manage billing account exists",
      404,
      "MANAGEMENT_SUBSCRIPTION_NOT_FOUND",
    );
  return {
    portalUrl: (
      await getOblienBillingApi().createPortal({
        namespace: row.namespace,
        returnUrl: billingUrl(),
      })
    ).url,
  };
}

/** Bounded shared DB cache, with the paid period checked on every read. No remote
 * billing request on each host command; signed events invalidate all replicas. */
export async function assertManagementActive(org: string) {
  assertCloud();
  let row = await repos.managementBilling.get(org);
  if (!row?.checkedAt || Date.now() - row.checkedAt.getTime() >= ACCESS_REFRESH_MS) {
    row = await lock(org, async () => {
      const current = await repos.managementBilling.get(org);
      return current?.checkedAt && Date.now() - current.checkedAt.getTime() < ACCESS_REFRESH_MS
        ? current
        : (await refresh(org)).row;
    });
  }
  const limit = managementServerLimit(row.verified, row.cloudCoveredUntil);
  if (!limit) throw managementRequired();
  return { row, limit };
}

const managementRequired = () =>
  new AppError(
    "Update your Manage plan to manage this server. Your apps and data continue running on your infrastructure.",
    402,
    "MANAGEMENT_PLAN_REQUIRED",
  );

export async function assertManagementAccess(org: string, serverId?: string) {
  if (!env.CLOUD_MODE) return;
  const { row, limit } = await assertManagementActive(org);
  const eligible = (await connected(org)).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  // A scheduled reduction must not be undermined by connecting more servers
  // during the remaining paid period. Existing access lasts until period end.
  const connectionLimit = Math.min(limit, row.verified?.newServerLimit ?? limit);
  const allowed = serverId
    ? eligible.slice(0, limit).some((server) => server.id === serverId)
    : eligible.length < connectionLimit;
  if (!allowed) throw managementRequired();
}

export async function syncManagementBilling(org: string) {
  return lock(org, async () => {
    await repos.managementBilling.update(org, { checkedAt: null });
    const current = await refresh(org);
    const { row, subscription, paid } = current;
    if (
      !subscription ||
      !paid ||
      subscription.cancelAtPeriodEnd ||
      (subscription.pendingChange && unfinished(subscription.pendingChange.status))
    )
      return current;
    const included = (row.cloudCoveredUntil?.getTime() ?? 0) > Date.now();
    if (included === paid.baseIncluded) return current;
    const api = getOblienBillingApi();
    // Never silently increase a recurring charge when Cloud coverage ends.
    // The already-paid period keeps its allowance; renewal stops and the user
    // can explicitly choose Manage at the published base price for the next one.
    const discounted = included
      ? managementCloudBenefitOffer(org, row.namespace, subscription)
      : null;
    if (!discounted) {
      const canceled = await api.cancelSubscription(row.namespace);
      managementTerms(org, row.namespace, canceled.subscription);
      if (!canceled.subscription?.cancelAtPeriodEnd)
        throw new AppError(
          "Management renewal has not been reconciled",
          502,
          "MANAGEMENT_BILLING_MISMATCH",
        );
    } else {
      const request = {
        ...discounted,
        billingInterval: "monthly" as const,
        idempotencyKey: key(
          org,
          `included:${row.namespace}:${subscription.periodStart}:${subscription.periodEnd}:${discounted.offer.reference}`,
        ),
      };
      let { quote } = await api.previewPlanChange(row.namespace, request);
      if (Date.parse(quote.expiresAt) <= Date.now()) {
        // Quotes are read-only. Rotate only a confirmed-expired quote; the
        // provider still serializes changes and refuses a second pending one.
        ({ quote } = await api.previewPlanChange(row.namespace, {
          ...request,
          idempotencyKey: key(
            org,
            `${request.idempotencyKey}:expired:${Math.floor(Date.now() / 60_000)}`,
          ),
        }));
      }
      if (
        !isDeepStrictEqual(quote.next, discounted.offer) ||
        quote.amountDueNow !== 0 ||
        Date.parse(quote.effectiveAt) < Date.parse(subscription.periodEnd!)
      )
        throw new AppError(
          "The management discount must apply at renewal without a charge",
          502,
          "MANAGEMENT_QUOTE_CHANGED",
        );
      await api.changePlan(row.namespace, {
        quoteId: quote.id,
        idempotencyKey: key(org, `included-confirm:${quote.id}`),
      });
    }
    return refresh(org);
  });
}

export async function isCustomerServer(org: string, serverId?: string | null): Promise<boolean> {
  if (!env.CLOUD_MODE || !serverId) return false;
  const server = await repos.server.getInOrganization(serverId, org);
  if (!server || server.isLocal || server.purpose === "migration_source")
    throw new AppError("Server is not available for deployment", 404, "SERVER_NOT_FOUND");
  if (server.workspaceId) return false;
  await assertManagementAccess(org, server.id);
  return true;
}
export async function isCustomerProject(org: string, projectId?: string): Promise<boolean> {
  if (!env.CLOUD_MODE || !projectId) return false;
  const project = await repos.project.findByIdInOrganization(projectId, org);
  if (!project) throw new AppError("Project not found", 404, "PROJECT_NOT_FOUND");
  return !project.workspaceId && isCustomerServer(org, project.serverId);
}
