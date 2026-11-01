import type { OblienEntitlement } from "../../lib/oblien-billing-api";

/** Provider snapshots are authoritative; a delayed event only prompts a read. */
export function creditAlertNotification(input: {
  eventType: string;
  eventId: string;
  timestamp: unknown;
  data: Record<string, unknown>;
  organizationId: string;
  workspaceId?: string;
  entitlement: OblienEntitlement;
  dashboardUrl: string;
}) {
  const { eventType, eventId, data, entitlement, organizationId } = input;
  // Late credit events cannot turn a paid capacity contract into a credit alert.
  if (entitlement.tierId === "capacity") return null;
  if (data.service !== undefined && data.service !== "workspace_vm") return null;
  const alert = entitlement.quota.alert;
  if (!alert || !["low", "grace", "depleted"].includes(alert.state)) return null;
  const created =
    typeof input.timestamp === "string" || typeof input.timestamp === "number"
      ? new Date(input.timestamp).getTime()
      : NaN;
  if (
    entitlement.periodStart &&
    Number.isFinite(created) &&
    created < new Date(entitlement.periodStart).getTime()
  )
    return null;
  const original = data.alert as { limit?: unknown } | undefined;
  if (original && original.limit !== alert.limit) return null;
  if (eventType === "namespace.quota.threshold") {
    if (
      alert.state !== "low" ||
      (typeof data.threshold === "number" && data.threshold !== alert.threshold)
    )
      return null;
  } else if (eventType === "credits.low") {
    if (alert.state !== "grace") return null;
  } else if (eventType === "credits.depleted") {
    if (alert.state !== "depleted" || entitlement.status !== "credit_exhausted") return null;
  } else return null;

  const url = new URL("/cloud-billing", input.dashboardUrl);
  url.searchParams.set("organizationId", organizationId);
  if (input.workspaceId) url.searchParams.set("workspaceId", input.workspaceId);
  const message =
    alert.state === "depleted"
      ? "Your Cloud credits are exhausted. New workloads are blocked. Open billing to buy more credits or review your plan."
      : alert.state === "grace"
        ? `Your paid Cloud credits are used up. ${Math.max(0, alert.balance ?? 0)} grace credits remain before new workloads are blocked. Open billing to buy more credits.`
        : `You have used ${alert.percent}% of your Cloud allowance, including purchased credits. ${Math.max(0, alert.remaining ?? 0)} credits remain. Open billing to buy more before they run out.`;
  return {
    organizationId,
    idempotencyKey: eventId,
    eventType: alert.state === "depleted" ? "billing.credit_exhausted" : "billing.credit_low",
    resourceType: "billing",
    resourceId: organizationId,
    payload: {
      message,
      url: url.toString(),
      namespace: entitlement.namespace,
      alert,
      sourceEventId: eventId,
      durable: true,
    },
  };
}
