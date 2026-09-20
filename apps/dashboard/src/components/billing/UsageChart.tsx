"use client";

import { useId } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useI18n } from "@/components/i18n-provider";
import { CHART_TOOLTIP_LABEL_STYLE, CHART_TOOLTIP_STYLE } from "@/lib/chart-theme";
import { formatBillingNumber, usageTimestamp, type CreditUsagePoint } from "@/lib/billing-usage";

export function UsageChart({ buckets, granularity }: { buckets: CreditUsagePoint[]; granularity: "day" | "week" }) {
  const { t, locale } = useI18n();
  const fillId = useId();
  const data = buckets.map((bucket) => ({ ...bucket, time: usageTimestamp(bucket.timestamp).getTime() }))
    .filter((bucket) => Number.isFinite(bucket.time)).sort((a, b) => a.time - b.time);
  const formatDate = (value: number) => new Date(value).toLocaleDateString(locale, { timeZone: "UTC", month: "short", day: "numeric" });
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }} accessibilityLayer>
        <defs><linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.3} />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.03} />
        </linearGradient></defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="time" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={formatDate} minTickGap={35} tick={{ fontSize: 11 }} />
        <YAxis tickFormatter={(value: number) => formatBillingNumber(value, locale)} tick={{ fontSize: 11 }} width={52} />
        <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelStyle={CHART_TOOLTIP_LABEL_STYLE}
          labelFormatter={(value) => `${formatDate(Number(value))}${granularity === "week" ? ` · ${t.billing.usage.granularity.week}` : ""}`}
          formatter={(value) => [formatBillingNumber(Number(value), locale), t.billing.resourcesGuide.credits]} />
        <Area type="linear" dataKey="credits" name={t.billing.resourcesGuide.credits} stroke="var(--primary)" fill={`url(#${fillId})`}
          strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
