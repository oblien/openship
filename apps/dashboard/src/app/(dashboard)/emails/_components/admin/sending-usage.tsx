"use client";

import { useCallback } from "react";
import { Icon } from "@repo/ui/icons";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { ResourceRing } from "@/components/billing/ResourceMeter";
import { OverviewStatCard } from "@/components/shared/OverviewStatCard";
import { Button } from "@/components/ui/button";
import { useScopedResource } from "@/hooks/use-scoped-resource";
import { managedMailApi } from "@/lib/api/managed-mail";

type SendingUsage = Awaited<ReturnType<typeof managedMailApi.usage>>;

export function useSendingUsage(enabled: boolean) {
  return useScopedResource(
    useCallback(() => (enabled ? managedMailApi.usage() : Promise.resolve(null)), [enabled]),
  );
}

export function QuotaRing({
  used,
  limit,
  label,
  large = false,
}: {
  used: number | null;
  limit?: number | null;
  label: string;
  large?: boolean;
}) {
  const { locale } = useI18n();
  if (limit === 0 && used !== null)
    return (
      <span
        aria-hidden="true"
        className={`flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground ${large ? "size-16" : "size-10"}`}
      >
        <Icon name="ban" className={large ? "size-6" : "size-4"} />
      </span>
    );
  const percentage =
    used !== null && limit != null && limit > 0 ? Math.min(100, (used * 100) / limit) : null;
  const percent = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  });
  const display =
    percentage === null
      ? "—"
      : percentage > 0 && percentage < 1
        ? "<" + percent.format(0.01)
        : percent.format(Math.floor(percentage) / 100);
  return (
    <ResourceRing label={label} used={used} max={limit} large={large}>
      <span
        className={
          large ? "text-sm font-semibold tabular-nums" : "text-[11px] font-semibold tabular-nums"
        }
      >
        {display}
      </span>
    </ResourceRing>
  );
}

interface SendingQuotaCardProps {
  compact?: boolean;
  usage?: SendingUsage | null;
  allowance?: number;
  inactive?: boolean;
  loading?: boolean;
  onRetry?: () => void;
}

export function SendingQuotaCard({
  compact = false,
  usage,
  allowance,
  inactive,
  loading,
  onRetry,
}: SendingQuotaCardProps) {
  const { t, locale } = useI18n();
  const c = t.emails.cloudClient;
  const limit = usage?.policy.period ?? allowance;
  const used = usage?.usedPeriod ?? (inactive ? 0 : null);
  const reserved = usage?.reservedPeriod ?? (inactive ? 0 : null);
  const remaining =
    limit != null && used !== null && reserved !== null
      ? Math.max(0, limit - used - reserved)
      : null;
  const number = (value?: number | null) => value?.toLocaleString(locale) ?? "—";
  const breakdown = used !== null && reserved !== null && (
    <>
      <span>{interpolate(c.sentUsage, { used: number(used), pending: number(reserved) })}</span>
      {remaining !== null && (
        <span className="block">
          {interpolate(c.recipientsLeft, { amount: number(remaining) })}
        </span>
      )}
    </>
  );
  return (
    <OverviewStatCard
      label={c.monthlySending}
      hint={compact && !loading && breakdown}
      icon={<Icon name="send" />}
      loading={loading}
      value={number(used)}
      limit={number(limit)}
      indicator={<QuotaRing large={!compact} label={c.monthlySending} used={used} limit={limit} />}
      subtext={
        breakdown ? (
          !compact && breakdown
        ) : (
          <>
            {t.billing.resourceOverview.unavailable}
            {onRetry && (
              <Button size="sm" variant="link" onClick={onRetry}>
                {t.actions.retry}
              </Button>
            )}
          </>
        )
      }
    />
  );
}
