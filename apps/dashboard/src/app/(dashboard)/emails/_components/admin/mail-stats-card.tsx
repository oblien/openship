"use client";

import type { ReactNode } from "react";
import type { ManagedMailSummary } from "@repo/contracts/managed-mail";
import { Icon as UiIcon, type IconName } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { OverviewStatCard } from "@/components/shared/OverviewStatCard";
import type { MailServerStats } from "@/lib/api";
import { formatBytes } from "@/lib/formatBytes";
import { QuotaRing } from "./sending-usage";

export function MailStatsCard({
  stats,
  loading,
  managed,
  limits,
  sending,
}: {
  managed?: boolean;
  limits?: ManagedMailSummary["limits"];
  stats: MailServerStats | null;
  loading?: boolean;
  sending?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const copy = t.emailsAdmin.overview;
  const number = (n?: number | null) => n?.toLocaleString(locale) ?? "—";
  const metrics: Array<{
    label: string;
    icon: IconName;
    value: string;
    used?: number;
    max?: number | null;
    limitLabel?: string;
  }> = [
    {
      label: copy.mailboxes,
      icon: "inbox",
      value: number(stats?.mailboxes.total),
      used: stats?.mailboxes.total,
      max: limits?.mailboxes,
    },
    {
      label: copy.domains,
      icon: "globe",
      value: number(stats?.domains.total),
      used: stats?.domains.total,
      max: limits?.domains,
    },
    {
      label: copy.storage,
      icon: "hard-drive",
      value: stats ? formatBytes(stats.storageBytes) : "—",
      used: stats?.storageBytes,
      max: limits && limits.storageMB * 1024 ** 2,
      limitLabel: limits && (limits.storageMB / 1024).toLocaleString(locale) + " GB",
    },
  ];
  if (!managed)
    metrics.push(
      { label: copy.messages, icon: "mail", value: number(stats?.messages) },
      { label: copy.aliases, icon: "forward", value: number(stats?.aliases.total) },
    );
  return (
    <div
      aria-label={copy.mailStats}
      className={`col-span-full grid grid-cols-1 gap-3 min-[450px]:grid-cols-2 ${managed ? "xl:grid-cols-4" : "xl:grid-cols-5"}`}
    >
      {sending}
      {metrics.map(({ label, icon, value, used, max, limitLabel }) => (
        <OverviewStatCard
          key={label}
          label={label}
          icon={<UiIcon name={icon} />}
          loading={loading}
          value={value}
          limit={max != null ? limitLabel ?? number(max) : undefined}
          indicator={
            max != null && max > 0 && <QuotaRing label={label} used={used ?? null} limit={max} />
          }
        />
      ))}
    </div>
  );
}
