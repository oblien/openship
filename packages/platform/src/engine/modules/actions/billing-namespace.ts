import { AppError } from "@repo/core";
import { env } from "../../config/env";
import { getOblienBillingApi } from "../../lib/oblien-client";
import { ensureCloudNamespace } from "../../lib/oblien-namespace";
import { findBillingOwnerByNamespace } from "../billing/billing-namespace-owner";
import { actionBillingNamespace } from "./billing";

/** Called under the Actions billing lock, after the order and budget are saved.
 * This prepares payment ownership only; paid runner provisioning is separate. */
export async function ensureActionsBillingNamespace(organizationId: string): Promise<void> {
  if (!env.CLOUD_MODE)
    throw new AppError(
      "Actions funding is managed by Openship Cloud",
      409,
      "ACTIONS_BILLING_CLOUD_ONLY",
    );
  const namespace = actionBillingNamespace(organizationId);
  const owner = await findBillingOwnerByNamespace(namespace);
  if (owner?.kind !== "actions" || owner.organizationId !== organizationId)
    throw new AppError(
      "Actions payment ownership could not be verified",
      409,
      "ACTIONS_CHECKOUT_CONFLICT",
    );

  await ensureCloudNamespace({
    name: "Openship Actions",
    slug: namespace,
    // Preparing checkout must not permit compute before paid runner setup.
    // These initial caps do not replace an existing namespace's limits.
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
  const billing = getOblienBillingApi();
  const [policy, entitlement, subscription] = await Promise.all([
    billing.getPolicy(namespace),
    billing.getEntitlement(namespace),
    billing.getSubscription(namespace),
  ]);
  if (entitlement.billingMode === "monthly" || entitlement.capacity || subscription.subscription)
    throw new AppError(
      "Actions funding must be separate from server subscriptions",
      409,
      "ACTIONS_FUNDING_INVALID",
    );
  if (
    policy.quotaLimit !== 0 ||
    policy.overdraft !== 0 ||
    policy.suspendThreshold !== 0 ||
    policy.onOverdraftAction !== "stop_workspaces"
  )
    throw new AppError(
      "Actions requires a prepaid Cloud policy with no included allowance or overdraft",
      503,
      "ACTIONS_FUNDING_POLICY_REQUIRED",
    );
  // Never reset usage, set a quota or grant provider credits here. Only verified
  // top-up fulfillment can increase this namespace's purchased allowance.
}
