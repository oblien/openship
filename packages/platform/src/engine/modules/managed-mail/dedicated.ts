import { dedicated, dedicatedCoverageEnd, dedicatedOffer, verifiedDedicatedResources, type Binding, type Order } from "./dedicated-contract";
export { dedicated, dedicatedOffer } from "./dedicated-contract";
import { assertHostedMailEnrollment } from "./billing";
import { createHash } from "node:crypto";
import { AppError, mailMonthlyCents, PRICING } from "@repo/core";
import { CLOUD_DOCKER_IMAGE, cloudWorkspaceCreationFailure, OblienError } from "@repo/adapters";
import { dedicatedMailMonthlyCents, type PaidMailPlan } from "@repo/core/managed-mail";
import { repos, type DedicatedMailOrder } from "@repo/db";
import { env, runtimeTarget } from "../../config/env";
import { getOblienBillingApi, getOblienClient } from "../../lib/oblien-client";
import { assertOblienEntitlementMatchesSubscription } from "../../lib/oblien-billing-api";
import { ensureCloudNamespace } from "../../lib/oblien-namespace";
import { findOwnedWorkspaceBySlug } from "../../lib/cloud-docker-workspace";
import { createProvisionLock } from "../../lib/provision-lock";
import { isExpiredCheckout } from "../billing/workspace-checkout";

function returnUrl(row: Order) {
  const url = new URL("/emails", runtimeTarget.dashboard);
  url.search = new URLSearchParams({
    organizationId: row.organizationId,
    serviceId: row.id,
  }).toString();
  return url.href;
}

async function session(row: Order) {
  const provider = getOblienBillingApi();
  const offer = dedicatedOffer(row);
  const { max_workspaces, ...limits } = offer.resourceLimits;
  await ensureCloudNamespace({
    name: offer.name,
    slug: row.billingNamespace,
    resource_limits: { ...limits, max_vms: max_workspaces },
  });
  const result = await provider.createCheckout({
    kind: "subscription",
    billingInterval: "monthly",
    namespace: row.billingNamespace,
    idempotencyKey: row.id,
    offer,
    metadata: {
      openship_product: "dedicated_mail",
      openship_organization: row.organizationId,
      openship_namespace: row.billingNamespace,
      openship_mail_service: row.id,
    },
    successUrl: returnUrl(row),
    cancelUrl: returnUrl(row),
  });
  if (row.checkoutId && row.checkoutId !== result.checkoutId)
    throw new AppError("The dedicated checkout identity changed.", 502);
  if (!row.checkoutId)
    await repos.managedMail.updateOrder(row.organizationId, row.id, {
      checkoutId: result.checkoutId,
    });
  return result;
}

export const orderLock = (org: string) => createProvisionLock("managed-mail:orders:" + org);

async function pendingState(row: Order) {
  if (!row.checkoutId) return "open";
  try {
    const { checkout } = await getOblienBillingApi().getCheckout(
      row.billingNamespace,
      row.checkoutId,
    );
    return checkout.status;
  } catch (error) {
    if (isExpiredCheckout(error)) return "expired";
    throw error;
  }
}

export function dedicatedOrderTerms(
  plan: PaidMailPlan,
  storageGB: number,
  current?: DedicatedMailOrder,
) {
  const catalog = PRICING.mail.dedicated;
  const storage =
    current?.storageGB === storageGB
      ? current
      : catalog.storage.find((size) => size.storageGB === storageGB);
  if (!storage || !PRICING.mail.plans[plan].checkoutAvailable)
    throw new AppError("Choose an available dedicated mail plan and storage size.", 400);
  const { recipients, dailyRecipients, domains } = PRICING.mail.plans[plan];
  return {
    plan,
    storageGB,
    vmMonthlyCents: storage.vmMonthlyCents,
    sendingMonthlyCents:
      current?.plan === plan ? current.sendingMonthlyCents : mailMonthlyCents(plan, "sending"),
    allowance:
      current?.plan === plan && current.allowance
        ? current.allowance
        : { recipients, dailyRecipients, domains },
    cpuCores: current?.cpuCores ?? catalog.cpuCores,
    memoryMB: current?.memoryMB ?? catalog.memoryMB,
    diskGB: storageGB + (current ? current.diskGB - current.storageGB : catalog.systemDiskGB),
  };
}

export async function dedicatedCheckout(
  org: string,
  plan: PaidMailPlan,
  storageGB: number,
  purchaseId: string,
  expectedMonthlyCents: number,
) {
  if (!env.BILLING_ENABLED) throw new AppError("Email checkout is unavailable.", 503);
  const digest = createHash("sha256")
    .update(JSON.stringify([org, purchaseId]))
    .digest("hex")
    .slice(0, 32);
  const id = "managed-mail-" + digest;
  return orderLock(org).run(async () => {
    const provider = getOblienBillingApi();
    const existing = await repos.managedMail.service(org, id);
    if (existing?.orderState === "funded") {
      dedicated(existing);
      const original = existing.order.purchase ?? {
        plan: existing.order.plan,
        storageGB: existing.order.storageGB,
        monthlyCents: dedicatedOffer(existing).unitAmount,
      };
      if (
        original.plan !== plan ||
        original.storageGB !== storageGB ||
        original.monthlyCents !== expectedMonthlyCents
      )
        throw new AppError("This purchase ID belongs to a different mail order.", 409);
      return { url: returnUrl(existing) };
    }
    assertHostedMailEnrollment(org);
    await provider.assertMonthlyCapacitySupport();
    const order = dedicatedOrderTerms(plan, storageGB);
    if (
      dedicatedMailMonthlyCents(order.vmMonthlyCents, order.sendingMonthlyCents) !==
      expectedMonthlyCents
    )
      throw new AppError("The price changed. Refresh and review the new total.", 409);
    if (existing?.orderState === "closed")
      throw new AppError("This checkout has ended. Review a new plan.", 409);
    let row: Binding | undefined =
      existing ??
      (await repos.managedMail.orders(org)).find((item) => item.orderState === "checkout");
    if (row) {
      dedicated(row);
      const state = await pendingState(row);

      if (state === "expired") {
        await repos.managedMail.updateOrder(org, row.id, { orderState: "closed" });
        if (row.id === id) throw new AppError("This checkout expired. Review a new plan.", 409);
        row = undefined;
      } else if (
        row.id !== id ||
        row.order.plan !== plan ||
        row.order.storageGB !== storageGB ||
        dedicatedOffer(row).unitAmount !== expectedMonthlyCents
      ) {
        throw new AppError(
          "Finish or cancel the pending dedicated checkout before choosing another plan.",
          409,
        );
      } else if (state === "complete") return { url: returnUrl(row) };
    }
    row ??= await repos.managedMail.createOrder({
      id,
      organizationId: org,
      placement: "dedicated",
      provisioning: true,
      billingNamespace: "openship-mail-vm-" + digest,
      orderState: "checkout",
      order: { ...order, webmailOwner: "customer" },
    });
    dedicated(row);
    return { url: (await session(row)).url };
  });
}

export async function manageDedicatedOrder(
  org: string,
  id: string,
  action: "resume" | "cancel" | "portal",
) {
  return orderLock(org).run(async () => {
    const row = await repos.managedMail.service(org, id);
    dedicated(row);
    const provider = getOblienBillingApi();
    if (action === "portal")
      return provider.createPortal({ namespace: row.billingNamespace, returnUrl: returnUrl(row) });
    if (row.orderState !== "checkout") throw new AppError("This checkout has finished.", 409);
    const state = await pendingState(row);
    if (state === "complete") {
      if (action === "resume") return { url: returnUrl(row) };
      throw new AppError("Payment is being reconciled.", 409);
    }
    if (action === "resume" && state === "open") {
      assertHostedMailEnrollment(org);
      if (!env.BILLING_ENABLED) throw new AppError("Email checkout is unavailable.", 503);
      return { url: (await session(row)).url };
    }
    if (state !== "expired") {
      const checkoutId = row.checkoutId ?? (await session(row)).checkoutId;
      const result = await provider.cancelCheckout(row.billingNamespace, checkoutId, {
        idempotencyKey: "cancel-" + row.id,
      });
      if (result.checkout.status !== "expired")
        throw new AppError("Checkout could not be canceled.", 409);
    }
    await repos.managedMail.updateOrder(org, row.id, { orderState: "closed" });
    if (action === "resume") throw new AppError("This checkout expired. Choose a new plan.", 409);
    return { canceled: true };
  });
}

/** The saved order owns the namespace, financial terms and VM size for every renewal. */
export async function dedicatedCoverage(row: Binding) {
  dedicated(row);
  if (!row.checkoutId) return null;
  const provider = getOblienBillingApi();
  const { subscription } = await provider.getSubscription(row.billingNamespace);
  if (!subscription || !["active", "trialing", "past_due"].includes(subscription.status))
    return null;
  verifiedDedicatedResources(row, subscription);
  const entitlement = await provider.getEntitlement(row.billingNamespace);
  if (entitlement.namespace !== row.billingNamespace)
    throw new AppError("Unexpected dedicated mail entitlement.", 502);
  assertOblienEntitlementMatchesSubscription(entitlement, subscription);
  const until = dedicatedCoverageEnd(entitlement, subscription);
  if (!until) return null;
  return {
    plan: row.order.plan,
    until,
    dedicated: true,
    allowance: row.order.allowance ?? PRICING.mail.plans[row.order.plan],
  };
}

export async function provisionDedicatedOrder(org: string, id: string) {
  return orderLock(org).run(async () => {
    const row = await repos.managedMail.service(org, id);
    if (!row || row.orderState === "closed" || row.cloudServerId) return;
    dedicated(row);
    if (!row.checkoutId) return;
    if (!(await dedicatedCoverage(row))) {
      if (row.orderState === "checkout" && (await pendingState(row)) === "expired")
        await repos.managedMail.updateOrder(org, id, { orderState: "closed" });
      return;
    }
    await repos.managedMail.updateOrder(org, id, { orderState: "funded" });
    const slug = row.billingNamespace;
    const client = getOblienClient();
    const vm = await client.vms
      .create({
        name: "OpenShip Mail · " + row.order.plan,
        slug,
        namespace: slug,
        image: CLOUD_DOCKER_IMAGE,
        mode: "permanent",
        wait_ready: false,
        idempotency_key: row.id,
        config: {
          cpus: row.order.cpuCores,
          memory_mb: row.order.memoryMB,
          disk_size_mb: row.order.diskGB * 1024,
          wait_for_init: true,
          network_config: { allow_internet: true, public_ingress: true },
        },
      })
      .catch(async (error) => {
        const failure = cloudWorkspaceCreationFailure(error);
        if (failure.workspaceId) return client.vms.get(failure.workspaceId);
        if (failure.capacityRejected || (error instanceof OblienError && error.status === 409)) {
          const recovered = await findOwnedWorkspaceBySlug(client, slug, slug);
          if (recovered) return recovered;
        }
        throw error;
      });
    if (!vm.id || vm.namespace !== slug || vm.slug !== slug)
      throw new AppError("Unexpected dedicated mail VM.", 502);
    await repos.managedMail.updateOrder(org, id, { cloudServerId: vm.id });
  });
}
