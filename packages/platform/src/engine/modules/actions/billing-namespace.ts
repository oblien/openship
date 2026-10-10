import { AppError, PRICING } from "@repo/core";
import { env } from "../../config/env";
import { getOblienBillingApi, getOblienClient } from "../../lib/oblien-client";
import { ensureCloudNamespace } from "../../lib/oblien-namespace";
import { findBillingOwnerByNamespace } from "../billing/billing-namespace-owner";
import { actionBillingNamespace } from "./billing";
import { saveCloudActionRunner } from "./cloud-runner";

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

/** Payment recovery invokes this only after validating a paid receipt, under
 * the organization's billing lock. This opens bounded allocation, not credit:
 * every worker still needs Oblien's positive balance and provider admission. */
export async function ensureFundedActionRunners(organizationId: string): Promise<void> {
  await ensureActionsBillingNamespace(organizationId);
  const namespace = actionBillingNamespace(organizationId);
  const { runners, maxParallel } = PRICING.actions;
  const maximum = {
    cpu: Math.max(...runners.map((r) => r.cpuCores)),
    memory: Math.max(...runners.map((r) => r.memoryMb)),
    disk: Math.max(...runners.map((r) => r.diskGb)),
  };
  const limits = {
    max_workspaces: maxParallel,
    max_vcpus: maximum.cpu,
    max_ram_mb: maximum.memory,
    max_disk_gb: maximum.disk,
    max_total_vcpus: maximum.cpu * maxParallel,
    max_total_ram_mb: maximum.memory * maxParallel,
    max_total_disk_gb: maximum.disk * maxParallel,
  };
  const client = getOblienClient();
  const current = await client.namespaces.get(namespace);
  if (!current.success || current.data?.slug !== namespace || !current.data.id)
    throw new AppError(
      "Actions namespace ownership could not be verified",
      502,
      "ACTIONS_FUNDING_INVALID",
    );
  const result = await client.namespaces.update(current.data.id, { resource_limits: limits });
  if (
    !result.success ||
    result.data?.slug !== namespace ||
    result.data.id !== current.data.id ||
    Object.entries(limits).some(
      ([key, value]) =>
        result.data.resource_limits?.[key as keyof typeof limits] !== value ||
        typeof result.data.effective_resource_limits?.[key as keyof typeof limits] !== "number" ||
        result.data.effective_resource_limits[key as keyof typeof limits]! < value,
    )
  )
    throw new AppError(
      "Actions runner capacity could not be confirmed. Your payment is saved; setup will retry automatically.",
      503,
      "ACTIONS_CAPACITY_UNAVAILABLE",
    );
  for (const runner of runners) {
    await saveCloudActionRunner(
      {
        organizationId,
        namespace,
        name: `Cloud Linux · ${runner.cpuCores} vCPU`,
        cpu: runner.cpuCores,
        memoryMb: runner.memoryMb,
        diskGb: runner.diskGb,
        maxParallel,
        image: "catthehacker/ubuntu:act-22.04",
        labels: ["ubuntu-latest", "ubuntu-22.04", `openship-${runner.id.replace("_", "-")}`],
      },
      runner.id,
    );
  }
}
