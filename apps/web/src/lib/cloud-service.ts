import type { PlanTierId } from "@repo/core";
import type { Copy } from "@/i18n/copy";

/** The public Cloud commitment, shared by pricing, the homepage and terms. */
export const CLOUD_SLA = {
  standardUptimePercent: 99,
  proUptimePercent: 99.9,
  termsHref: "/sla",
  maintenanceNoticeDays: 7,
  claimWindowDays: 30,
  claimReviewBusinessDays: 15,
  creditIssueDays: 30,
  creditTiers: [
    { minimumUptimePercent: 98.5, creditPercent: 10 },
    { minimumUptimePercent: 95, creditPercent: 25 },
    { minimumUptimePercent: 0, creditPercent: 100 },
  ],
} as const;

/** The billing catalog uses the team ID for Scale. */
export function cloudSlaUptimePercent(plan: PlanTierId) {
  return plan === "pro" || plan === "team"
    ? CLOUD_SLA.proUptimePercent
    : CLOUD_SLA.standardUptimePercent;
}

export function cloudSlaPlanSummary(copy: Copy) {
  return copy(
    "Hobby and Starter include {standard}% monthly uptime. Pro and Scale include {pro}%.",
    { standard: CLOUD_SLA.standardUptimePercent, pro: CLOUD_SLA.proUptimePercent },
  );
}
