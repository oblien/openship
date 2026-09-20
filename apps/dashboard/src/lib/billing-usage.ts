/** Balances arrive in milli-credits; usage buckets already contain whole credits. */
export function formatMilliCredits(value: number | null | undefined, locale: string): string {
  return value == null ? "—" : formatBillingNumber(value / 1000, locale);
}

export function formatBillingNumber(value: number, locale: string): string {
  return value.toLocaleString(locale, { maximumFractionDigits: 2 });
}

export interface CreditUsagePoint {
  timestamp: string;
  credits: number;
}

export interface CloudUsageTotals {
  cpu_time_minutes: number;
  memory_gb_minutes: number;
  disk_io_gb: number;
  network_gb: number;
  vcpu_hours: number;
  gb_hours: number;
  credits: number;
  records: number;
}

export interface CloudUsagePayload {
  buckets: CreditUsagePoint[];
  totals: CloudUsageTotals;
}

/** Oblien can return UTC SQL timestamps without an explicit timezone. */
export function usageTimestamp(value: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z` : value);
}

/** A date picker includes the entire final day, capped at now. */
export function billingUsageWindow(from: string, to: string, now = new Date()): { from: string; to: string } | null {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T23:59:59.999Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())
    || start.toISOString().slice(0, 10) !== from || end.toISOString().slice(0, 10) !== to
    || start > end || start > now) return null;
  return { from: start.toISOString(), to: new Date(Math.min(end.getTime(), now.getTime())).toISOString() };
}

export function weeklyCreditUsage(buckets: CreditUsagePoint[]): CreditUsagePoint[] {
  const weeks = new Map<string, number>();
  for (const bucket of buckets) {
    const monday = usageTimestamp(bucket.timestamp);
    if (!Number.isFinite(monday.getTime())) continue;
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    monday.setUTCHours(0, 0, 0, 0);
    const key = monday.toISOString();
    weeks.set(key, (weeks.get(key) ?? 0) + bucket.credits);
  }
  return [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([timestamp, credits]) => ({ timestamp, credits }));
}
