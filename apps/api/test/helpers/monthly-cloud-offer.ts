import type { OblienEntitlement, OblienSubscription } from "@repo/platform/engine/lib/oblien-billing-api";

/** Saved v9 terms and the SDK 2.8 capacity shape, independent of today's catalog. */
export function monthlyCloudBilling(organizationId = "org_1", namespace = "os-customer") {
  const periodStart = "2026-10-01T00:00:00Z";
  const periodEnd = "2026-11-01T00:00:00Z";
  const pool = { vcpus: 4, memoryMb: 16384, diskGb: 128, workspaces: 1 };
  const subscription: NonNullable<OblienSubscription> = {
    tierId: "reseller", status: "active", billingInterval: "monthly",
    periodStart, periodEnd, cancelAtPeriodEnd: false, canceledAt: null,
    offer: {
      reference: "openship:pro:v9", name: "Openship Pro", unitAmount: 3900, currency: "usd",
      billingMode: "monthly", credits: 0, capacity: pool,
      resourceLimits: { max_workspaces: 1, max_vcpus: 4, max_ram_mb: 16384, max_disk_gb: 128,
        max_total_vcpus: 4, max_total_ram_mb: 16384, max_total_disk_gb: 128 },
    },
    metadata: {
      openship_plan: "pro", openship_offer_version: "9", openship_organization: organizationId,
      openship_namespace: namespace,
      openship_limits: JSON.stringify({ workloads: ["static", "web", "worker"], services: true,
        runningServices: null, maxProjects: null, maxResourceTier: "high",
        maxServiceResources: { cpuCores: 4, memoryMb: 16384 },
        computeMinutesPerMonth: null, buildMinutesPerMonth: null, freeSubdomains: 100,
        customDomains: null, seats: null }),
    },
  };
  const entitlement: OblienEntitlement = {
    success: true, namespace, tierId: "capacity", status: "active", periodStart, periodEnd,
    billingMode: "monthly", computeCovered: true,
    quota: { limit: null, used: 0, balance: null, alert: null },
    capacity: {
      id: "capacity-test", namespace, billingMode: "monthly", status: "active", provider: "stripe",
      capacity: pool, tariffId: "workspace-capacity-2026-10-v1", currency: "usd",
      monthlyAmount: 4640, paygCapAmount: 5800, periodStart, periodEnd, autoRenew: true, computeCovered: true,
      retention: { minimumDays: 30, automaticDeletion: false, reviewAt: "2026-12-01T00:00:00Z",
        storagePerGiBMonth: 0.05, amountDue: 0, currency: "usd" },
      pendingChange: null, savings: null,
      network: { service: "managed_proxy_transfer", included: false, purchasedBytes: 0,
        consumedBytes: 0, reservedBytes: 0, availableBytes: 0 },
    },
  };
  return { subscription, entitlement, balance: {
    success: true, namespace, billingMode: "monthly" as const, computeCovered: true,
    blocking: false, balance: null, paidThrough: periodEnd,
  } };
}
