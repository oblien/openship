/** The public Cloud commitment, shared by pricing, the homepage and terms. */
export const CLOUD_SLA = {
  monthlyUptimePercent: 99,
  termsHref: "/terms#uptime-sla",
  maintenanceNoticeDays: 7,
  claimWindowDays: 30,
  claimReviewBusinessDays: 15,
  creditIssueDays: 30,
  creditTiers: [
    { minimumUptimePercent: 95, creditPercent: 10 },
    { minimumUptimePercent: 90, creditPercent: 25 },
    { minimumUptimePercent: 0, creditPercent: 100 },
  ],
} as const;
