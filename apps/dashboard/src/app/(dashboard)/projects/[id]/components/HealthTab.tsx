"use client";

/**
 * Health tab — the incidents the container health watch recorded for this project.
 *
 * An empty list here is ambiguous on its own ("nothing broke" vs "nobody was
 * looking"), so the endpoint also reports whether the watch job is enabled and
 * whether the box this project runs on is currently unreachable. Both get their
 * own banner, because a silent empty state is the failure mode that makes an
 * operator trust a monitor that isn't running.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  HeartPulse,
  RefreshCw,
  RotateCw,
  ServerOff,
  ShieldAlert,
} from "lucide-react";
import Link from "next/link";
import { projectsApi, type ServiceIncidentRow } from "@/lib/api/projects";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { timeAgo } from "@/lib/time";
import type { Dictionary } from "@/i18n";

type IncidentKind = ServiceIncidentRow["kind"];

/** Matches `formatDowntime` in the API's incident service, so the tab and the
 *  alert message that pointed here quote the same duration. */
function formatDowntime(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/* `down` is the loudest thing a container can do; `unhealthy` is still serving
   (or at least still up), so it reads as a warning rather than an outage. */
const KIND_TONE: Record<IncidentKind, string> = {
  down: "bg-danger-bg text-danger",
  crash_loop: "bg-danger-bg text-danger",
  unhealthy: "bg-warning-bg text-warning",
  server_unreachable: "bg-danger-bg text-danger",
};

const KIND_ICON: Record<IncidentKind, typeof Activity> = {
  down: ShieldAlert,
  crash_loop: RotateCw,
  unhealthy: AlertTriangle,
  server_unreachable: ServerOff,
};

function kindLabel(kind: IncidentKind, c: Dictionary["projects"]["health"]): string {
  return c.kinds[kind] ?? kind;
}

export function HealthTab() {
  const { t } = useI18n();
  const c = t.projects.health;
  const { projectData } = useProjectSettings();
  const projectId = projectData.id;

  const [open, setOpen] = useState<ServiceIncidentRow[]>([]);
  const [resolved, setResolved] = useState<ServiceIncidentRow[]>([]);
  const [historyDays, setHistoryDays] = useState(30);
  const [serverUnreachable, setServerUnreachable] = useState<ServiceIncidentRow | null>(null);
  const [watching, setWatching] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await projectsApi.listIncidents(projectId);
      setOpen(res.open ?? []);
      setResolved(res.resolved ?? []);
      setHistoryDays(res.historyDays ?? 30);
      setServerUnreachable(res.serverUnreachable ?? null);
      setWatching(res.watching);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <HealthSkeleton />;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border/50 bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <HeartPulse className="size-[18px]" />
            </div>
            <div>
              <h2 className="text-[15px] font-semibold text-foreground">{c.title}</h2>
              <p className="text-xs text-muted-foreground">{c.subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setRefreshing(true);
              void refresh();
            }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border/60 px-3 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/50"
          >
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} /> {c.refresh}
          </button>
        </div>

        {/* Both banners answer "is this list even trustworthy right now?" — the
            watch being off means nothing can ever appear, and an unreachable box
            means the watcher froze every row it has for this project. */}
        {!watching && (
          <Banner tone="warning" icon={AlertTriangle} title={c.watchOffTitle} body={c.watchOffBody}>
            <Link href="/jobs" className="font-medium underline underline-offset-2">
              {c.watchOffCta}
            </Link>
          </Banner>
        )}
        {serverUnreachable && (
          <Banner
            tone="danger"
            icon={ServerOff}
            title={c.serverDownTitle}
            body={interpolate(c.serverDownBody, {
              duration: formatDowntime(Date.now() - new Date(serverUnreachable.openedAt).getTime()),
            })}
          />
        )}
        {failed && <Banner tone="warning" icon={AlertTriangle} title={c.loadFailed} body="" />}

        <div className="mt-4">
          <SectionLabel>{c.openTitle}</SectionLabel>
          {open.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/50 px-4 py-6 text-center text-sm text-muted-foreground">
              {watching ? c.emptyOpen : c.emptyUnwatched}
            </p>
          ) : (
            <ul className="space-y-2.5">
              {open.map((row) => (
                <IncidentRow key={row.id} row={row} />
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-border/50 bg-card p-5">
        <SectionLabel>{interpolate(c.recentTitle, { days: String(historyDays) })}</SectionLabel>
        {resolved.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/50 px-4 py-6 text-center text-sm text-muted-foreground">
            {c.emptyRecent}
          </p>
        ) : (
          <ul className="space-y-2.5">
            {resolved.map((row) => (
              <IncidentRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ── Row ─────────────────────────────────────────────────────────────────── */

function IncidentRow({ row }: { row: ServiceIncidentRow }) {
  const { t } = useI18n();
  const c = t.projects.health;
  const [showLog, setShowLog] = useState(false);

  const Icon = KIND_ICON[row.kind] ?? Activity;
  const isOpen = row.status === "open";
  const duration = row.resolvedAt
    ? formatDowntime(new Date(row.resolvedAt).getTime() - new Date(row.openedAt).getTime())
    : formatDowntime(Date.now() - new Date(row.openedAt).getTime());

  // Only the facts Docker actually gave us — an absent exit code is a container
  // that never exited, not a zero.
  const facts: string[] = [];
  if (row.exitCode != null) facts.push(interpolate(c.exitCode, { code: String(row.exitCode) }));
  if (row.restartCount > 0)
    facts.push(interpolate(c.restarts, { count: String(row.restartCount) }));
  if (row.oomKilled) facts.push(c.oomKilled);

  return (
    <li className={`rounded-xl border border-border/50 p-3 ${isOpen ? "" : "opacity-75"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${KIND_TONE[row.kind] ?? "bg-neutral-bg text-neutral"}`}
            >
              <Icon className="size-3" />
              {kindLabel(row.kind, c)}
            </span>
            <span className="truncate text-sm font-medium text-foreground">{row.serviceName}</span>
            {!isOpen && (
              <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-success">
                {c.recovered}
              </span>
            )}
          </div>
          {row.reason && <p className="mt-1 text-xs text-muted-foreground">{row.reason}</p>}
          {facts.length > 0 && (
            <p className="mt-1 font-mono text-[11px] text-muted-foreground/80">
              {facts.join(" · ")}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className={`text-xs font-medium ${isOpen ? "text-danger" : "text-muted-foreground"}`}>
            {interpolate(isOpen ? c.ongoing : c.lasted, { duration })}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">
            {interpolate(c.started, { when: timeAgo(row.openedAt, t) })}
          </p>
        </div>
      </div>

      {row.logExcerpt && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown className={`size-3.5 transition-transform ${showLog ? "rotate-180" : ""}`} />
            {showLog ? c.hideLog : c.showLog}
          </button>
          {showLog && (
            <pre className="mt-1.5 max-h-56 overflow-auto rounded-lg bg-muted/50 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {row.logExcerpt}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

/* ── Bits ────────────────────────────────────────────────────────────────── */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
      {children}
    </h3>
  );
}

function Banner({
  tone,
  icon: Icon,
  title,
  body,
  children,
}: {
  tone: "warning" | "danger";
  icon: typeof Activity;
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  const cls =
    tone === "danger"
      ? "border-danger-border bg-danger-bg text-danger"
      : "border-warning-border bg-warning-bg text-warning";
  return (
    <div className={`mt-4 flex items-start gap-2.5 rounded-xl border px-3 py-2.5 ${cls}`}>
      <Icon className="mt-px size-4 shrink-0" />
      <div className="min-w-0 text-xs">
        <p className="font-semibold">{title}</p>
        {body && <p className="mt-0.5 opacity-90">{body}</p>}
        {children && <p className="mt-1">{children}</p>}
      </div>
    </div>
  );
}

function HealthSkeleton() {
  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border/50 bg-card p-5">
        <div className="flex items-start gap-3">
          <div className="size-9 shrink-0 animate-pulse rounded-xl bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-[15px] w-32 animate-pulse rounded bg-muted" />
            <div className="h-3 w-64 animate-pulse rounded bg-muted" />
          </div>
        </div>
        <div className="mt-5 space-y-2.5">
          <div className="h-16 animate-pulse rounded-xl bg-muted" />
          <div className="h-16 animate-pulse rounded-xl bg-muted" />
        </div>
      </div>
      <div className="rounded-2xl border border-border/50 bg-card p-5">
        <div className="h-3 w-40 animate-pulse rounded bg-muted" />
        <div className="mt-3 h-16 animate-pulse rounded-xl bg-muted" />
      </div>
    </div>
  );
}
