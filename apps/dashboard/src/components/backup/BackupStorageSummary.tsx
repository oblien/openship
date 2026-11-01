import { Icon, type IconName } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import type { BackupDestinationSummary } from "@/lib/api";
import { formatBytes } from "@/lib/formatBytes";

export function BackupStorageSummary({
  destinations,
  showDestinationCount = false,
  compact = false,
}: {
  destinations: BackupDestinationSummary[];
  showDestinationCount?: boolean;
  compact?: boolean;
}) {
  const { t, locale } = useI18n();
  const m = t.misc.backups;
  const stats = destinations.flatMap((d) => (d.stats ? [d.stats] : []));
  const savedKnown = stats.every((s) => s.savedCount !== undefined);
  const total = (
    field: "storedBytes" | "savedCount" | "activeCount" | "failedCount" | "cancelledCount",
  ) => stats.reduce((n, s) => n + (s[field] ?? 0), 0);
  const active = total("activeCount");
  const failed = total("failedCount");
  const cancelled = total("cancelledCount");
  const last = stats.reduce((latest, s) => Math.max(latest, Date.parse(s.lastRunAt ?? "") || 0), 0);
  return (
    <section
      aria-label={m.summaryTitle}
      className={
        compact ? "rounded-2xl bg-card p-5" : "rounded-2xl border border-border/50 bg-card p-5"
      }
    >
      <div className={compact ? "sr-only" : "mb-4 flex items-center gap-2"}>
        <Icon name="hard-drive" className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">{m.summaryTitle}</h2>
      </div>
      <dl
        className={
          compact
            ? "grid grid-cols-2 gap-x-6 gap-y-5 lg:grid-cols-4 [&>div]:flex-col [&>div]:items-start [&>div]:justify-start [&>div]:gap-2 [&_dt]:text-xs [&_dd]:text-start [&_dd]:text-lg [&_dd]:tabular-nums"
            : "space-y-3"
        }
      >
        <Stat icon="database" label={m.summaryStored} value={formatBytes(total("storedBytes"))} />
        <Stat
          icon="check-circle"
          label={m.summaryBackups}
          value={savedKnown ? String(total("savedCount")) : "—"}
        />
        {active > 0 && (
          <Stat icon="spinner" label={m.summaryActive} value={String(active)} tone="text-info" />
        )}
        {failed > 0 && (
          <Stat icon="x-circle" label={m.summaryFailed} value={String(failed)} tone="text-danger" />
        )}
        {cancelled > 0 && (
          <Stat icon="circle" label={m.summaryCancelled} value={String(cancelled)} />
        )}
        <Stat
          icon="clock"
          label={m.statsLast}
          valueClassName={compact ? "!text-sm" : undefined}
          value={
            last
              ? new Date(last).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
              : "—"
          }
        />
        {showDestinationCount && (
          <Stat icon="server" label={m.summaryDestinations} value={String(destinations.length)} />
        )}
      </dl>
    </section>
  );
}

function Stat({
  label,
  value,
  icon,
  tone = "text-foreground",
  valueClassName = "",
}: {
  label: string;
  value: string;
  icon: IconName;
  tone?: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <dt className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <Icon name={icon} className="size-4 shrink-0" />
        {label}
      </dt>
      <dd className={`text-end font-medium ${tone} ${valueClassName}`}>{value}</dd>
    </div>
  );
}
