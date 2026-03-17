import {
  Cpu,
  HardDrive,
  MemoryStick,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Activity,
  Wifi,
  WifiOff,
} from "lucide-react";
import type { ComponentStatus, ServerStats } from "@/lib/api/system";

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

function UsageBar({
  pct,
  colorClass,
}: {
  pct: number;
  colorClass: string;
}) {
  return (
    <div className="h-2 bg-muted rounded-full overflow-hidden mt-2">
      <div
        className={`h-full rounded-full transition-all duration-700 ease-out ${colorClass}`}
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
  iconWrapClass,
  barClass,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  pct?: number;
  iconWrapClass: string;
  barClass?: string;
}) {
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${iconWrapClass}`}>
          <Icon className="size-[18px]" />
        </div>
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <p className="text-2xl font-semibold text-foreground tracking-tight">
        {value}
      </p>
      {sub && (
        <p className="text-xs text-muted-foreground mt-1">{sub}</p>
      )}
      {pct != null && barClass && <UsageBar pct={pct} colorClass={barClass} />}
    </div>
  );
}

export function OverviewTab({
  stats,
  components,
  checking,
  monitorConnected,
  monitorError,
  onReconnectMonitor,
}: {
  stats: ServerStats | null;
  components: ComponentStatus[];
  checking: boolean;
  monitorConnected: boolean;
  monitorError: string | null;
  onReconnectMonitor: () => void;
}) {
  const healthyCount = components.filter((c) => c.healthy).length;
  const totalCount = components.length;
  const allHealthy = totalCount > 0 && healthyCount === totalCount;

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
      {/* Monitor status bar */}
  

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Cpu}
          label="CPU"
          value={stats ? `${stats.cpu}%` : "—"}
          sub={stats ? `Load ${stats.load1} / ${stats.load5} / ${stats.load15}` : undefined}
          pct={stats?.cpu ?? undefined}
          iconWrapClass="bg-blue-500/10 text-blue-500"
          barClass="bg-blue-500"
        />
        <StatCard
          icon={MemoryStick}
          label="Memory"
          value={stats ? `${memPct}%` : "—"}
          sub={
            stats
              ? `${formatBytes(stats.memUsed)} / ${formatBytes(stats.memTotal)}`
              : undefined
          }
          pct={memPct ?? undefined}
          iconWrapClass="bg-violet-500/10 text-violet-500"
          barClass="bg-violet-500"
        />
        <StatCard
          icon={HardDrive}
          label="Disk"
          value={stats ? `${diskPct}%` : "—"}
          sub={
            stats
              ? `${formatBytes(stats.diskUsed)} / ${formatBytes(stats.diskTotal)}`
              : undefined
          }
          pct={diskPct ?? undefined}
          iconWrapClass="bg-amber-500/10 text-amber-500"
          barClass="bg-amber-500"
        />
        <StatCard
          icon={Clock}
          label="Uptime"
          value={stats ? formatUptime(stats.uptime) : "—"}
          iconWrapClass="bg-emerald-500/10 text-emerald-500"
        />
      </div>

      {/* Components quick health */}
      <div className="bg-card rounded-2xl border border-border/50">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
          <div className="w-9 h-9 bg-emerald-500/10 rounded-xl flex items-center justify-center">
            <Activity className="size-[18px] text-emerald-500" />
          </div>
          <div className="flex-1">
            <h2 className="font-semibold text-foreground text-[15px]">
              Components
            </h2>
            <p className="text-xs text-muted-foreground">
              {checking
                ? "Checking\u2026"
                : allHealthy
                  ? "All systems operational"
                  : totalCount > 0
                    ? `${totalCount - healthyCount} issue${totalCount - healthyCount > 1 ? "s" : ""} detected`
                    : "No data"}
            </p>
          </div>
        </div>
        <div className="p-5 space-y-1">
          {checking && totalCount === 0 ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : totalCount > 0 ? (
            components.map((comp) => (
              <div
                key={comp.name}
                className="flex items-center gap-3 py-2 px-2 rounded-lg"
              >
                <div className="shrink-0">
                  {comp.healthy ? (
                    <CheckCircle2 className="size-4 text-emerald-500" />
                  ) : (
                    <XCircle className="size-4 text-orange-500" />
                  )}
                </div>
                <span className="text-sm text-foreground flex-1">
                  {comp.label || comp.name}
                </span>
                {comp.version && (
                  <span className="text-xs text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
                    v{comp.version}
                  </span>
                )}
                <span
                  className={`text-xs font-medium ${
                    comp.healthy ? "text-emerald-500" : "text-orange-500"
                  }`}
                >
                  {comp.healthy ? "Healthy" : "Unhealthy"}
                </span>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground text-center py-6">
              No health data yet
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
