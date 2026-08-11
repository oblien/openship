"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Clock, Loader2, Play, Pencil, Check, X,
  Plus, Trash2, ScrollText, DatabaseBackup, ArrowRight, Search,
} from "lucide-react";
import { jobsApi, getApiErrorMessage, type JobView, type BackupScheduleView } from "@/lib/api";
import { PageContainer } from "@/components/ui/PageContainer";
import { JobRunLogsModal } from "@/components/jobs/JobRunLogs";
import { JobsEmptyState } from "@/components/jobs/JobsEmptyState";
import { formatTime, formatDuration, statusTone, statusIcon } from "@/components/jobs/jobFormat";
import { usePlatform } from "@/context/PlatformContext";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";

// Overview facets double as the list filter. Independent predicates (a failed
// job can also be scheduled) — each row shows its own count; "all" is the total.
type JobStatusFilter = "all" | "running" | "failed" | "scheduled" | "disabled";

function matchesJobStatus(job: JobView, f: JobStatusFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "running":
      return job.lastRun?.status === "running";
    case "failed":
      return job.lastRun?.status === "failed";
    case "scheduled":
      return job.enabled && !!job.nextRunAt;
    case "disabled":
      return !job.enabled;
  }
}

export default function JobsPage() {
  const { t } = useI18n();
  const j = t.jobs;
  const { selfHosted } = usePlatform();
  const { showToast } = useToast();
  const router = useRouter();

  const [jobs, setJobs] = useState<JobView[]>([]);
  const [backupSchedules, setBackupSchedules] = useState<BackupScheduleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [cronDraft, setCronDraft] = useState("");
  const [logRunId, setLogRunId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("all");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      // Backup schedules are a read-only side view — never let them fail the
      // whole page, so their fetch degrades to empty on error.
      const [res, bs] = await Promise.all([
        jobsApi.list(),
        jobsApi.backupSchedules().catch(() => ({ data: [] as BackupScheduleView[] })),
      ]);
      setJobs(res?.data ?? []);
      setBackupSchedules(bs?.data ?? []);
    } catch (err) {
      showToast(getApiErrorMessage(err, j.loadFailed), "error", j.toast.title);
    } finally {
      setLoading(false);
    }
  }, [j.loadFailed, j.toast.title, showToast]);

  useEffect(() => {
    if (selfHosted) void load();
    else setLoading(false);
  }, [selfHosted, load]);

  const handleRun = async (job: JobView) => {
    if (busyKey) return;
    setBusyKey(job.key);
    try {
      const res = await jobsApi.run(job.key);
      showToast(interpolate(j.toast.ran, { label: job.label }), "success", j.toast.title);
      if (res?.data?.runId) setLogRunId(res.data.runId);
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, interpolate(j.toast.ranFailed, { label: job.label })), "error", j.toast.title);
    } finally {
      setBusyKey(null);
    }
  };

  const handleToggle = async (job: JobView) => {
    if (busyKey) return;
    setBusyKey(job.key);
    try {
      const next = !job.enabled;
      await jobsApi.update(job.key, { enabled: next });
      showToast(interpolate(next ? j.toast.enabled : j.toast.disabled, { label: job.label }), "success", j.toast.title);
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, interpolate(j.toast.toggleFailed, { label: job.label })), "error", j.toast.title);
    } finally {
      setBusyKey(null);
    }
  };

  const handleSaveCron = async (job: JobView) => {
    if (busyKey || !cronDraft.trim()) return;
    setBusyKey(job.key);
    try {
      await jobsApi.update(job.key, { cronExpression: cronDraft.trim() });
      showToast(interpolate(j.toast.saved, { label: job.label }), "success", j.toast.title);
      setEditingKey(null);
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, interpolate(j.toast.saveFailed, { label: job.label })), "error", j.toast.title);
    } finally {
      setBusyKey(null);
    }
  };

  const handleDelete = async (job: JobView) => {
    if (busyKey || !window.confirm(j.delete.confirm)) return;
    setBusyKey(job.key);
    try {
      await jobsApi.remove(job.key);
      showToast(j.toast.deleted, "success", j.toast.title);
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, j.toast.deleteFailed), "error", j.toast.title);
    } finally {
      setBusyKey(null);
    }
  };

  const systemJobs = jobs.filter((job) => job.kind !== "custom");
  const customJobs = jobs.filter((job) => job.kind === "custom");

  // Search (by label) + status facet. Counts are over ALL jobs so the overview
  // is stable while a filter narrows the list.
  const q = query.trim().toLowerCase();
  const jobMatches = (job: JobView) =>
    (!q || job.label.toLowerCase().includes(q)) && matchesJobStatus(job, statusFilter);
  const filteredCustom = customJobs.filter(jobMatches);
  const filteredSystem = systemJobs.filter(jobMatches);
  const counts: Record<JobStatusFilter, number> = {
    all: jobs.length,
    running: jobs.filter((jb) => jb.lastRun?.status === "running").length,
    failed: jobs.filter((jb) => jb.lastRun?.status === "failed").length,
    scheduled: jobs.filter((jb) => jb.enabled && !!jb.nextRunAt).length,
    disabled: jobs.filter((jb) => !jb.enabled).length,
  };
  // Backups are a read-only side view — shown only in the unfiltered ("all")
  // status, matched by name only.
  const filteredBackups =
    statusFilter === "all"
      ? backupSchedules.filter((s) => {
          if (!q) return true;
          return `${s.projectName ?? ""} ${s.serviceName ?? ""} ${s.payloadKind ?? ""}`
            .toLowerCase()
            .includes(q);
        })
      : [];
  // Genuine "no custom jobs" empty state — only when nothing is being filtered.
  const showCustomEmpty = customJobs.length === 0 && statusFilter === "all" && !q;
  const hasAnyMatch =
    filteredCustom.length > 0 || filteredSystem.length > 0 || filteredBackups.length > 0;
  // The two-column "cool" layout (search + overview sidebar) only earns its
  // keep once there's custom activity to manage. With no custom jobs the page
  // is just the empty state + built-in system jobs — show that full-width.
  const showOverview = customJobs.length > 0;

  const renderCard = (job: JobView) => {
    const busy = busyKey === job.key;
    const editing = editingKey === job.key;
    const isCustom = job.kind === "custom";
    const scheduleText =
      job.scheduleType === "once" ? j.create.scheduleTypes.once
      : job.scheduleType === "manual" ? j.create.scheduleTypes.manual
      : job.cronExpression ?? "—";
    return (
      <div key={job.key} className="rounded-2xl border border-border/60 bg-card px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Clock className="size-4 text-muted-foreground/70" />
              <Link href={`/jobs/${encodeURIComponent(job.key)}`} className="text-[14px] font-medium text-foreground hover:text-primary">
                {job.label}
              </Link>
              <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {isCustom ? j.kind.custom : j.kind.system}
              </span>
            </div>
            <div className="mt-1.5"><StatusPill job={job} /></div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isCustom && job.lastRun && (
              <button
                onClick={() => job.lastRun && setLogRunId(job.lastRun.id)}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-foreground/[0.06] px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
              >
                <ScrollText className="size-3.5" /> {j.actions.viewLogs}
              </button>
            )}
            <button
              onClick={() => void handleRun(job)}
              disabled={busy}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-foreground/[0.06] px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1] disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              {busy ? j.actions.running : j.actions.run}
            </button>
            <button
              onClick={() => void handleToggle(job)}
              disabled={busy}
              title={job.enabled ? j.actions.disable : j.actions.enable}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${job.enabled ? "bg-primary" : "bg-muted"}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${job.enabled ? "translate-x-6" : "translate-x-1"}`} />
            </button>
            {isCustom && (
              <button
                onClick={() => void handleDelete(job)}
                disabled={busy}
                title={j.delete.action}
                className="inline-flex min-h-8 items-center rounded-lg px-2 text-muted-foreground transition-colors hover:bg-danger-bg hover:text-danger disabled:opacity-50"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 border-t border-border/40 pt-3 sm:grid-cols-2">
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-muted-foreground/70 w-20 shrink-0">{j.fields.schedule}</span>
            {editing ? (
              <div className="flex items-center gap-1.5">
                <input value={cronDraft} onChange={(e) => setCronDraft(e.target.value)} spellCheck={false}
                  className="w-40 rounded-md border border-border/60 bg-background px-2 py-1 font-mono text-[12px] text-foreground outline-none focus:border-primary" />
                <button onClick={() => void handleSaveCron(job)} disabled={busy} className="text-success disabled:opacity-50"><Check className="size-4" /></button>
                <button onClick={() => setEditingKey(null)} disabled={busy} className="text-muted-foreground hover:text-foreground disabled:opacity-50"><X className="size-4" /></button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <code className="font-mono text-[12px] text-foreground">{scheduleText}</code>
                {job.scheduleType === "recurring" && (
                  <button onClick={() => { setEditingKey(job.key); setCronDraft(job.cronExpression ?? ""); }} title={j.actions.edit} className="text-muted-foreground/60 hover:text-foreground"><Pencil className="size-3.5" /></button>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-muted-foreground/70 w-20 shrink-0">{j.fields.nextRun}</span>
            <span className="text-[12px] text-foreground">{job.enabled ? formatTime(job.nextRunAt) : j.fields.notScheduled}</span>
          </div>
        </div>

        {job.lastRun?.error && (
          <p className="mt-2 truncate text-[12px] text-danger" title={job.lastRun.error}>{job.lastRun.error}</p>
        )}
      </div>
    );
  };

  return (
    <PageContainer>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>{j.title}</h1>
          <p className="text-sm text-muted-foreground/70 mt-1">{j.subtitle}</p>
        </div>
        {selfHosted && (
          <button onClick={() => router.push("/jobs/new")}
            className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90">
            <Plus className="size-4" /> {j.newJob}
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {/* Search sits above the columns so the overview card starts level
              with the list, not the search box (matches the projects page). */}
          {showOverview && (
            <div className="relative mb-4 max-w-md">
              <Search className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={j.searchPlaceholder}
                className="w-full ps-10 pe-4 py-2.5 bg-card border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/20 transition-all"
              />
            </div>
          )}

          <div className={showOverview ? "grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]" : ""}>
            {/* Left — filtered job sections */}
            <div className="min-w-0 space-y-8">
              {showCustomEmpty ? (
                <section className="space-y-3">
                  <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground/70">{j.sections.custom}</h2>
                  <JobsEmptyState onCreate={() => router.push("/jobs/new")} />
                </section>
              ) : filteredCustom.length > 0 ? (
                <section className="space-y-3">
                  <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground/70">{j.sections.custom}</h2>
                  <div className="space-y-3">{filteredCustom.map(renderCard)}</div>
                </section>
              ) : null}

              {filteredSystem.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground/70">{j.sections.system}</h2>
                  <div className="space-y-3">{filteredSystem.map(renderCard)}</div>
                </section>
              )}

              {filteredBackups.length > 0 && (
                <section className="space-y-3">
                  <div>
                    <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground/70">{j.backups.section}</h2>
                    <p className="mt-1 text-[12px] text-muted-foreground/60">{j.backups.sectionDesc}</p>
                  </div>
                  <div className="space-y-3">
                    {filteredBackups.map((s) => <BackupScheduleCard key={s.policyId} s={s} />)}
                  </div>
                </section>
              )}

              {jobs.length > 0 && !hasAnyMatch && !showCustomEmpty && (
                <div className="rounded-2xl border border-border/50 bg-card px-5 py-12 text-center text-sm text-muted-foreground">
                  {j.noResults}
                </div>
              )}
            </div>

            {/* Right — at-a-glance overview (only once custom jobs exist) */}
            {showOverview && (
              <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
                <JobsOverview counts={counts} active={statusFilter} onSelect={setStatusFilter} />
              </div>
            )}
          </div>
        </>
      )}

      {logRunId && <JobRunLogsModal runId={logRunId} onClose={() => setLogRunId(null)} />}
    </PageContainer>
  );
}

/** Sticky right-column overview. Each facet row shows its count and, on click,
 *  filters the list to that status (clicking the active row — or "All jobs" —
 *  resets). Mirrors the servers page quick-info card chrome. */
function JobsOverview({
  counts,
  active,
  onSelect,
}: {
  counts: Record<JobStatusFilter, number>;
  active: JobStatusFilter;
  onSelect: (f: JobStatusFilter) => void;
}) {
  const { t } = useI18n();
  const o = t.jobs.overview;
  const rows: Array<{ key: JobStatusFilter; label: string; dot?: string }> = [
    { key: "all", label: o.all },
    { key: "running", label: o.running, dot: "bg-warning-solid" },
    { key: "failed", label: o.failed, dot: "bg-danger-solid" },
    { key: "scheduled", label: o.scheduled, dot: "bg-info-solid" },
    { key: "disabled", label: o.disabled, dot: "bg-muted-foreground/40" },
  ];
  return (
    <div className="rounded-2xl border border-border/50 bg-card">
      <div className="flex items-center gap-3 border-b border-border/50 px-5 py-4">
        <div className="flex size-9 items-center justify-center rounded-xl bg-muted">
          <ScrollText className="size-[18px] text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">{o.title}</h2>
          <p className="text-xs text-muted-foreground">{o.subtitle}</p>
        </div>
      </div>
      <div className="p-2">
        {rows.map((r) => {
          const isActive = active === r.key;
          return (
            <button
              key={r.key}
              type="button"
              onClick={() => onSelect(isActive && r.key !== "all" ? "all" : r.key)}
              className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-start transition-colors ${
                isActive ? "bg-primary/10" : "hover:bg-muted/40"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className={`size-1.5 shrink-0 rounded-full ${r.dot ?? "bg-transparent"}`} />
                <span className={`truncate text-sm ${isActive ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                  {r.label}
                </span>
              </span>
              <span className={`text-sm font-medium tabular-nums ${isActive ? "text-foreground" : "text-muted-foreground/80"}`}>
                {counts[r.key]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StatusPill({ job }: { job: JobView }) {
  const { t } = useI18n();
  const j = t.jobs;
  const run = job.lastRun;
  if (!run) return <span className="text-[12px] text-muted-foreground/70">{j.fields.never}</span>;
  const tone = statusTone(run.status);
  const Icon = statusIcon(run.status);
  const label = run.status === "success" ? j.status.success : run.status === "failed" ? j.status.failed : j.status.running;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${tone}`}>
      <Icon className={`size-3.5 ${run.status === "running" ? "animate-spin" : ""}`} />
      {label}
      <span className="text-muted-foreground/60 font-normal">
        · {formatTime(run.startedAt)}{run.durationMs != null ? ` (${formatDuration(run.durationMs)})` : ""}
      </span>
    </span>
  );
}

/** Map a backup_run status onto the job status vocabulary used by the shared
 *  tone/icon helpers (backups use "succeeded"/"server_error"/"cancelled"). */
function normalizeBackupStatus(status: string): string {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "server_error") return "failed";
  return "running"; // queued / preparing / cancelled / in-flight → amber
}

/** Read-only card for a scheduled backup policy, surfaced in the Jobs tab.
 *  No run/toggle/delete — management lives under the project's Backups tab. */
function BackupScheduleCard({ s }: { s: BackupScheduleView }) {
  const { t } = useI18n();
  const j = t.jobs;
  const isMail = s.sourceKind === "mail_server";
  const title = isMail
    ? j.backups.mailServer
    : s.serviceName
      ? `${s.projectName ?? "—"} / ${s.serviceName}`
      : s.projectName ?? "—";
  const manageHref = isMail ? "/emails" : s.projectId ? `/projects/${s.projectId}/backup` : null;
  const run = s.lastRun;
  const norm = run ? normalizeBackupStatus(run.status) : null;
  const Icon = norm ? statusIcon(norm) : null;
  const runLabel = !run
    ? null
    : run.status === "succeeded"
      ? j.backups.status.succeeded
      : run.status === "failed" || run.status === "server_error"
        ? j.backups.status.failed
        : run.status === "cancelled"
          ? j.backups.status.cancelled
          : j.backups.status.running;
  return (
    <div className="rounded-2xl border border-border/60 bg-card px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <DatabaseBackup className="size-4 shrink-0 text-muted-foreground/70" />
            <span className="truncate text-[14px] font-medium text-foreground">{title}</span>
            <span className="rounded-md bg-info-bg px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-info">{j.backups.badge}</span>
            {!isMail && !s.serviceName && (
              <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{j.backups.projectDefault}</span>
            )}
            <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">{s.payloadKind}</span>
          </div>
          <div className="mt-1.5">
            {run && Icon ? (
              <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${statusTone(norm!)}`}>
                <Icon className={`size-3.5 ${norm === "running" ? "animate-spin" : ""}`} />
                {runLabel}
                <span className="font-normal text-muted-foreground/60">· {formatTime(run.startedAt)}</span>
              </span>
            ) : (
              <span className="text-[12px] text-muted-foreground/70">{j.backups.never}</span>
            )}
          </div>
        </div>
        {manageHref && (
          <Link
            href={manageHref}
            className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg bg-foreground/[0.06] px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
          >
            {j.backups.manage} <ArrowRight className="size-3.5 rtl:rotate-180" />
          </Link>
        )}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 border-t border-border/40 pt-3 sm:grid-cols-2">
        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[12px] text-muted-foreground/70">{j.fields.schedule}</span>
          <code className="font-mono text-[12px] text-foreground">{s.cronExpression}</code>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[12px] text-muted-foreground/70">{j.fields.nextRun}</span>
          <span className="text-[12px] text-foreground">{s.enabled ? formatTime(s.nextRunAt) : j.fields.notScheduled}</span>
        </div>
      </div>
    </div>
  );
}

