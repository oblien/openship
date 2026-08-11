"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft, Clock, Loader2, Play, Settings2, Trash2,
  Server as ServerIcon, GitBranch, Bell, Zap, ScrollText,
} from "lucide-react";
import { jobsApi, getApiErrorMessage, type JobView, type JobRunSummary } from "@/lib/api";
import { PageContainer } from "@/components/ui/PageContainer";
import { JobRunLogsModal } from "@/components/jobs/JobRunLogs";
import { formatTime as fmtTime, formatDuration as fmtDur, statusTone, statusIcon } from "@/components/jobs/jobFormat";
import { usePlatform } from "@/context/PlatformContext";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";

type Tab = "overview" | "runs";
const TABS: Tab[] = ["overview", "runs"];

export default function JobDetailPage() {
  const { t } = useI18n();
  const j = t.jobs;
  const router = useRouter();
  const params = useParams();
  const key = decodeURIComponent(String(params.key));
  const { selfHosted } = usePlatform();
  const { showToast } = useToast();

  const [job, setJob] = useState<JobView | null>(null);
  const [runs, setRuns] = useState<JobRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false);
  const [logRunId, setLogRunId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [detail, history] = await Promise.all([jobsApi.get(key), jobsApi.listRuns(key, 50)]);
      setJob(detail.data);
      setRuns(history.data ?? []);
    } catch (err) {
      showToast(getApiErrorMessage(err, j.loadFailed), "error", j.toast.title);
    } finally {
      setLoading(false);
    }
  }, [key, j.loadFailed, j.toast.title, showToast]);

  useEffect(() => {
    if (selfHosted) void load();
    else setLoading(false);
  }, [selfHosted, load]);

  const isCustom = job?.kind === "custom";

  const handleRun = async () => {
    if (!job || busy) return;
    setBusy(true);
    try {
      const res = await jobsApi.run(job.key);
      showToast(interpolate(j.toast.ran, { label: job.label }), "success", j.toast.title);
      if (res?.data?.runId) setLogRunId(res.data.runId);
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, interpolate(j.toast.ranFailed, { label: job.label })), "error", j.toast.title);
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async () => {
    if (!job || busy) return;
    setBusy(true);
    try {
      await jobsApi.update(job.key, { enabled: !job.enabled });
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, j.toast.toggleFailed), "error", j.toast.title);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!job || busy || !window.confirm(j.delete.confirm)) return;
    setBusy(true);
    try {
      await jobsApi.remove(job.key);
      showToast(j.toast.deleted, "success", j.toast.title);
      router.push("/jobs");
    } catch (err) {
      showToast(getApiErrorMessage(err, j.toast.deleteFailed), "error", j.toast.title);
      setBusy(false);
    }
  };

  if (loading) {
    return <PageContainer><div className="flex items-center justify-center py-20"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div></PageContainer>;
  }
  if (!job) {
    return <PageContainer><p className="py-20 text-center text-sm text-muted-foreground">{j.loadFailed}</p></PageContainer>;
  }

  const cfg = job.actionConfig ?? {};
  const scheduleText =
    job.scheduleType === "recurring" ? job.cronExpression ?? "—"
    : job.scheduleType === "once" ? `${j.detail.onceAt} ${fmtTime(job.runAt)}`
    : j.create.scheduleTypes.manual;

  return (
    <PageContainer>
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <button onClick={() => router.push("/jobs")} className="flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-muted">
          <ArrowLeft className="size-4 text-muted-foreground rtl:rotate-180" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>{job.label}</h1>
            <span className="shrink-0 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {isCustom ? j.kind.custom : j.kind.system}
            </span>
            {job.lastRun && <StatusBadge status={job.lastRun.status} label={j.status[job.lastRun.status as "success" | "failed" | "running"] ?? job.lastRun.status} />}
          </div>
          <p className="mt-1 truncate font-mono text-[12px] text-muted-foreground/60">{job.key}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button onClick={() => void handleRun()} disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl bg-muted/50 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} {j.actions.run}
          </button>
          {isCustom && (
            <button onClick={() => router.push(`/jobs/${encodeURIComponent(job.key)}/edit`)}
              className="inline-flex items-center gap-2 rounded-xl bg-muted/50 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted">
              <Settings2 className="size-4" /> {j.edit.action}
            </button>
          )}
          <button onClick={() => void handleToggle()} disabled={busy} title={job.enabled ? j.actions.disable : j.actions.enable}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${job.enabled ? "bg-primary" : "bg-muted"}`}>
            <span className={`inline-block h-4 w-4 rounded-full bg-background transition-transform ${job.enabled ? "translate-x-6" : "translate-x-1"}`} />
          </button>
          {isCustom && (
            <button onClick={() => void handleDelete()} disabled={busy} title={j.delete.action}
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-danger-bg hover:text-danger disabled:opacity-50">
              <Trash2 className="size-4" />
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex items-center gap-1 border-b border-border/50">
        {TABS.map((tb) => (
          <button key={tb} onClick={() => setTab(tb)}
            className={`relative px-4 py-2.5 text-sm font-medium transition-colors ${tab === tb ? "text-foreground" : "text-muted-foreground hover:text-foreground/70"}`}>
            {j.detail.tabs[tb]}{tb === "runs" && runs.length > 0 ? ` (${runs.length})` : ""}
            {tab === tb && <span className="absolute bottom-0 start-0 end-0 h-0.5 rounded-full bg-primary" />}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <div className="max-w-3xl space-y-3">
          <InfoRow icon={Clock} label={j.fields.schedule} value={<code className="font-mono text-[12px]">{scheduleText}</code>} />
          <InfoRow icon={Clock} label={j.fields.nextRun} value={job.enabled ? fmtTime(job.nextRunAt) : j.fields.notScheduled} />
          {isCustom && (
            <>
              <InfoRow icon={ServerIcon} label={j.detail.servers} value={(cfg.serverIds ?? (cfg.serverId ? [cfg.serverId] : [])).join(", ") || "—"} />
              <div className="rounded-xl border border-border/50 bg-card p-4">
                <p className="mb-2 text-[12px] font-medium text-muted-foreground">{j.create.command}</p>
                <pre className="overflow-x-auto rounded-lg bg-[#0b0b0c] px-3 py-2.5 font-mono text-[12px] text-neutral-200">{cfg.command}</pre>
              </div>
              {cfg.retry && <InfoRow icon={Zap} label={j.detail.retry} value={interpolate(j.detail.retryValue, { n: String(cfg.retry.maxAttempts), s: String(cfg.retry.backoffSeconds) })} />}
              {cfg.timeoutMs && <InfoRow icon={Clock} label={j.create.timeout} value={`${Math.round(cfg.timeoutMs / 1000)}s`} />}
              {cfg.env && Object.keys(cfg.env).length > 0 && <InfoRow icon={GitBranch} label={j.create.env} value={Object.keys(cfg.env).join(", ")} />}
              {cfg.secrets && Object.keys(cfg.secrets).length > 0 && <InfoRow icon={GitBranch} label={j.create.secrets} value={Object.keys(cfg.secrets).map((k) => `${k}=••••`).join(", ")} />}
              {job.dependsOn && job.dependsOn.length > 0 && <InfoRow icon={GitBranch} label={j.create.dependencies} value={job.dependsOn.join(", ")} />}
              {job.triggerEvents && job.triggerEvents.length > 0 && <InfoRow icon={Zap} label={j.create.triggers} value={job.triggerEvents.join(", ")} />}
              {job.notifyConfig && job.notifyConfig.channels.length > 0 && (
                <InfoRow icon={Bell} label={j.create.notifications} value={interpolate(j.detail.notifyValue, { c: String(job.notifyConfig.channels.length), s: job.notifyConfig.states.join(", ") })} />
              )}
            </>
          )}
        </div>
      ) : (
        <div className="max-w-3xl space-y-2">
          {runs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/60 py-12 text-center text-sm text-muted-foreground">{j.detail.noRuns}</div>
          ) : (
            runs.map((run) => <RunRow key={run.id} run={run} onOpen={() => setLogRunId(run.id)} />)
          )}
        </div>
      )}

      {logRunId && <JobRunLogsModal runId={logRunId} onClose={() => setLogRunId(null)} />}
    </PageContainer>
  );
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  const map: Record<string, string> = {
    success: "bg-success-bg text-success",
    failed: "bg-danger-bg text-danger",
    running: "bg-warning-bg text-warning",
  };
  const Icon = statusIcon(status);
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${map[status] ?? "bg-muted text-muted-foreground"}`}>
      <Icon className={`size-3 ${status === "running" ? "animate-spin" : ""}`} />
      {label}
    </span>
  );
}

function InfoRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border/50 bg-card px-4 py-3">
      <Icon className="mt-0.5 size-4 text-muted-foreground/60" />
      <span className="w-28 shrink-0 text-[12px] text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words text-[13px] text-foreground">{value}</span>
    </div>
  );
}

function RunRow({ run, onOpen }: { run: JobRunSummary; onOpen: () => void }) {
  const tone = statusTone(run.status);
  const Icon = statusIcon(run.status);
  return (
    <button onClick={onOpen} className="flex w-full items-center gap-3 rounded-xl border border-border/50 bg-card px-4 py-3 text-left transition-colors hover:bg-muted/40">
      <Icon className={`size-4 shrink-0 ${tone} ${run.status === "running" ? "animate-spin" : ""}`} />
      <span className="w-40 shrink-0 text-[13px] text-foreground">{fmtTime(run.startedAt)}</span>
      <span className="w-16 shrink-0 text-[12px] text-muted-foreground">{fmtDur(run.durationMs)}</span>
      <span className="w-24 shrink-0 text-[12px] text-muted-foreground">{run.trigger}{run.attempt > 1 ? ` #${run.attempt}` : ""}</span>
      {run.serverId && <span className="truncate text-[12px] text-muted-foreground/60">{run.serverId}</span>}
      <ScrollText className="ml-auto size-3.5 shrink-0 text-muted-foreground/50" />
    </button>
  );
}
