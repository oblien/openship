import { Icon as UiIcon, type IconName } from "@repo/ui/icons";
import type { ComponentStatus, ServerStats } from "@/lib/api/system";
import { useI18n, interpolate } from "@/components/i18n-provider";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function formatUptime(seconds: string): string {
  const s = Math.floor(parseFloat(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * Usage bar. Neutral foreground tone by default - amber when the value
 * climbs past 70%, red past 90%. The colour is a function of the data,
 * not arbitrary per-metric branding.
 */
function UsageBar({ pct }: { pct: number }) {
  const tone =
    pct >= 90
      ? "bg-danger-solid"
      : pct >= 70
        ? "bg-warning-solid"
        : "bg-foreground/60";
  return (
    <div className="h-1.5 bg-muted rounded-full overflow-hidden mt-3">
      <div
        className={`h-full rounded-full transition-all duration-700 ease-out ${tone}`}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  pct,
}: {
  icon: IconName;
  label: string;
  value: string;
  sub?: string;
  pct?: number;
}) {
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-center gap-2 mb-3">
        <UiIcon name={Icon}
          className="size-4 text-muted-foreground"
        />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </span>
      </div>
      <p className="text-2xl font-semibold text-foreground tracking-tight tabular-nums">
        {value}
      </p>
      {sub && (
        <p className="text-xs text-muted-foreground mt-1 tabular-nums">{sub}</p>
      )}
      {pct != null && <UsageBar pct={pct} />}
    </div>
  );
}

export function OverviewTab({
  stats,
  components,
  checking,
}: {
  stats: ServerStats | null;
  components: ComponentStatus[];
  checking: boolean;
  monitorConnected: boolean;
  monitorError: string | null;
  onReconnectMonitor: () => void;
}) {
  const { t } = useI18n();
  const healthyCount = components.filter((c) => c.healthy).length;
  const totalCount = components.length;
  const allHealthy = totalCount > 0 && healthyCount === totalCount;
  const unhealthyCount = totalCount - healthyCount;

  const memPct =
    stats && stats.memTotal > 0
      ? Math.round((stats.memUsed / stats.memTotal) * 100)
      : null;
  const diskPct =
    stats && stats.diskTotal > 0
      ? Math.round((stats.diskUsed / stats.diskTotal) * 100)
      : null;

  return (
    <div className="space-y-6">
      {/* Stat cards - neutral icons; the bar tone is the only thing that
          changes with the data, so resting state is calm and high usage
          stands out. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={"cpu"}
          label={t.servers.overview.cpu}
          value={stats ? `${stats.cpu}%` : "-"}
          sub={
            stats
              ? interpolate(t.servers.overview.load, {
                  load1: String(stats.load1),
                  load5: String(stats.load5),
                  load15: String(stats.load15),
                })
              : undefined
          }
          pct={stats?.cpu ?? undefined}
        />
        <StatCard
          icon={"memory"}
          label={t.servers.overview.memory}
          value={stats ? `${memPct}%` : "-"}
          sub={
            stats
              ? interpolate(t.servers.overview.usageOf, {
                  used: formatBytes(stats.memUsed),
                  total: formatBytes(stats.memTotal),
                })
              : undefined
          }
          pct={memPct ?? undefined}
        />
        <StatCard
          icon={"hard-drive"}
          label={t.servers.overview.disk}
          value={stats ? `${diskPct}%` : "-"}
          sub={
            stats
              ? interpolate(t.servers.overview.usageOf, {
                  used: formatBytes(stats.diskUsed),
                  total: formatBytes(stats.diskTotal),
                })
              : undefined
          }
          pct={diskPct ?? undefined}
        />
        <StatCard
          icon={"clock"}
          label={t.servers.overview.uptime}
          value={stats ? formatUptime(stats.uptime) : "-"}
          sub={stats ? t.servers.overview.sinceLastBoot : undefined}
        />
      </div>

      {/* Components - inline-header card pattern matching the rest of
          the dashboard. No icon-in-emerald-circle; just a small muted
          icon next to the heading. */}
      <div className="bg-card rounded-2xl border border-border/50 p-5">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2 min-w-0">
            <UiIcon name="activity"
              className="size-4 text-muted-foreground shrink-0"
            />
            <h2 className="font-semibold text-foreground text-sm">
              {t.servers.overview.components}
            </h2>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">
            {checking
              ? t.servers.overview.checking
              : allHealthy
                ? t.servers.overview.allOperational
                : totalCount > 0
                  ? interpolate(t.servers.overview.unhealthyOf, {
                      unhealthy: String(unhealthyCount),
                      total: String(totalCount),
                    })
                  : t.servers.overview.noData}
          </span>
        </div>

        {checking && totalCount === 0 ? (
          <div className="flex items-center justify-center py-8">
            <UiIcon name="spinner" className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : totalCount > 0 ? (
          <div className="divide-y divide-border/40 -mx-5">
            {components.map((comp) => (
              <div
                key={comp.name}
                className="flex items-center gap-3 px-5 py-3"
              >
                {comp.healthy ? (
                  <UiIcon name="check-circle"
                    className="size-4 text-success shrink-0"
                  />
                ) : (
                  <UiIcon name="x-circle"
                    className="size-4 text-danger shrink-0"
                  />
                )}
                <span className="text-sm text-foreground flex-1 truncate">
                  {comp.label || comp.name}
                </span>
                {comp.version && (
                  <span className="text-[11px] font-mono text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
                    v{comp.version}
                  </span>
                )}
                <span
                  className={`text-xs font-medium ${
                    comp.healthy
                      ? "text-success"
                      : "text-danger"
                  }`}
                >
                  {comp.healthy ? t.servers.overview.healthy : t.servers.overview.unhealthy}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-6">
            {t.servers.overview.noHealthData}
          </p>
        )}
      </div>
    </div>
  );
}
