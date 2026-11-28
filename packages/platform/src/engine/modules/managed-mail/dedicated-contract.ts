import { AppError } from "@repo/core";
import { dedicatedMailMonthlyCents } from "@repo/core/managed-mail";
import type { repos } from "@repo/db";
import { isDeepStrictEqual } from "node:util";
import type { OblienEntitlement, OblienSubscription } from "../../lib/oblien-billing-api";
import { monthlyCapacity } from "../billing/billing-capacity";
import { matchesAppliedSubscription } from "../billing/subscription-change-lifecycle";

export function isDedicatedMailNamespace(namespace: string | null | undefined) {
  return namespace?.startsWith("openship-mail-vm-") === true;
}

export function assertComputeBillingOwner(namespace: string | null | undefined) {
  if (isDedicatedMailNamespace(namespace))
    throw new AppError("Manage this dedicated VM's subscription in Emails.", 409, "DEDICATED_MAIL_BILLING");
}

export type Binding = NonNullable<Awaited<ReturnType<typeof repos.managedMail.service>>>;
export type Order = Binding & {
  organizationId: string;
  billingNamespace: string;
  order: NonNullable<Binding["order"]>;
};

export function dedicated(row: Binding | null): asserts row is Order {
  if (!row?.order || !row.organizationId || !row.billingNamespace || row.orderState === "closed")
    throw new AppError("Dedicated mail service not found.", 404);
}

export function dedicatedOffer(row: Order) {
  const { cpuCores, memoryMB, diskGB, plan, storageGB, sendingMonthlyCents, vmMonthlyCents } =
    row.order;
  const resourceLimits = {
    max_workspaces: 1,
    max_vcpus: cpuCores,
    max_ram_mb: memoryMB,
    max_disk_gb: diskGB,
    max_total_vcpus: cpuCores,
    max_total_ram_mb: memoryMB,
    max_total_disk_gb: diskGB,
  };
  return {
    reference: "openship:mail:dedicated:v1:" + row.id.slice("managed-mail-".length),
    name: "OpenShip Dedicated Mail · " + plan,
    description: `Private mail server with ${storageGB} GB of mailbox storage and managed sending`,
    billingMode: "monthly" as const,
    currency: "usd" as const,
    credits: 0,
    unitAmount: dedicatedMailMonthlyCents(vmMonthlyCents, sendingMonthlyCents),
    resourceLimits,
    capacity: monthlyCapacity(resourceLimits),
  };
}

export function dedicatedCoverageEnd(entitlement: OblienEntitlement, subscription: NonNullable<OblienSubscription>): Date | null {
  const end = new Date(entitlement.periodEnd ?? "");
  return ["active", "trialing", "past_due"].includes(subscription.status) && entitlement.status === "active" &&
    entitlement.computeCovered && end.getTime() > Date.now() ? end : null;
}

/** Check the paid offer against the immutable order before giving it mailbox or VM access. */
export function verifiedDedicatedResources(row: Order, subscription: NonNullable<OblienSubscription>) {
  // Keep the existing allowance available while the confirmed disk expansion is being applied.
  const changing = row.change;
  const approved =
    changing?.confirmationKey &&
    !changing.completed &&
    changing.nextOrder &&
    matchesAppliedSubscription(subscription, changing)
      ? changing.nextOrder
      : row.order;
  const offer = dedicatedOffer({ ...row, order: approved });
  const meta = subscription.metadata;
  const paid = subscription.offer;
  if (
    meta?.openship_product !== "dedicated_mail" ||
    meta.openship_organization !== row.organizationId ||
    meta.openship_mail_service !== row.id ||
    meta.openship_namespace !== row.billingNamespace ||
    subscription.billingInterval !== "monthly" ||
    paid?.reference !== offer.reference ||
    paid.unitAmount !== offer.unitAmount ||
    paid.billingMode !== offer.billingMode ||
    paid.currency !== offer.currency ||
    paid.credits !== 0 ||
    !isDeepStrictEqual(paid.capacity, offer.capacity) ||
    !isDeepStrictEqual(paid.resourceLimits, offer.resourceLimits)
  )
    throw new AppError("The dedicated mail subscription does not match its order.", 502);
  return offer.resourceLimits;
}
