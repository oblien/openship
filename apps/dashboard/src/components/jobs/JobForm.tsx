"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Plus, Trash2, Server as ServerIcon, CalendarClock, ShieldCheck, KeyRound, GitBranch, Bell, ArrowRight, BookOpen, ListChecks, Terminal, FileText, Upload } from "lucide-react";
import {
  jobsApi,
  notificationsApi,
  getApiErrorMessage,
  type JobView,
  type JobInput,
  type JobTriggerEvent,
  type JobRunState,
} from "@/lib/api";
import type { NotificationChannel } from "@/lib/api/notifications";
import { systemApi, type ServerInfo } from "@/lib/api/system";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";
import { Checkbox } from "@/components/ui/Checkbox";
import { parseDotenv } from "@/lib/dotenv";

type KV = { key: string; value: string };
const NOTIFY_STATES: JobRunState[] = ["running", "success", "failed"];
const DOCS_URL = "https://openship.io/docs/guides/jobs";
const inputCls =
  "w-full rounded-xl border border-border/60 bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary/50";
/** Subtle bordered action button (Paste/Upload .env), matching the form theme. */
const ghostBtn =
  "inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground";

const mapToRows = (m?: Record<string, string> | null): KV[] =>
  m ? Object.entries(m).map(([key, value]) => ({ key, value })) : [];
const rowsToMap = (rows: KV[]): Record<string, string> =>
  Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));
/** Merge parsed .env rows into existing rows (parsed wins per key), keeping order. */
const mergeEnv = (existing: KV[], parsed: KV[]): KV[] => {
  const map = new Map(existing.filter((r) => r.key.trim()).map((r) => [r.key, r]));
  for (const p of parsed) map.set(p.key, p);
  return [...map.values()];
};

/** Full-page create/edit form for a custom job. `job` present → edit. */
export function JobForm({
  job,
  onSaved,
  onCancel,
}: {
  job?: JobView;
  onSaved: (saved: JobView) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const j = t.jobs;
  const c = j.create;
  const { showToast } = useToast();
  const editing = !!job;
  const cfg = job?.actionConfig ?? undefined;

  const [label, setLabel] = useState(job?.label ?? "");
  const [command, setCommand] = useState(cfg?.command ?? "");
  const [scheduleType, setScheduleType] = useState<"recurring" | "once" | "manual">(
    (job?.scheduleType as "recurring" | "once" | "manual") ?? "recurring",
  );
  const [cron, setCron] = useState(job?.cronExpression ?? "0 3 * * *");
  const [runAt, setRunAt] = useState(job?.runAt ? job.runAt.slice(0, 16) : "");
  const [serverIds, setServerIds] = useState<string[]>(
    cfg?.serverIds ?? (cfg?.serverId ? [cfg.serverId] : []),
  );
  const [timeoutSec, setTimeoutSec] = useState(cfg?.timeoutMs ? String(Math.round(cfg.timeoutMs / 1000)) : "");
  const [maxAttempts, setMaxAttempts] = useState(String(cfg?.retry?.maxAttempts ?? 1));
  const [backoffSec, setBackoffSec] = useState(String(cfg?.retry?.backoffSeconds ?? 0));
  const [envRows, setEnvRows] = useState<KV[]>(mapToRows(cfg?.env));
  const envFileRef = useRef<HTMLInputElement>(null);
  const [editSecrets, setEditSecrets] = useState(!editing);
  const [secretRows, setSecretRows] = useState<KV[]>(mapToRows(cfg?.secrets));
  const [dependsOn, setDependsOn] = useState<string[]>(job?.dependsOn ?? []);
  const [triggerIds, setTriggerIds] = useState<string[]>(job?.triggerEvents ?? []);
  const [notifyChannels, setNotifyChannels] = useState<string[]>(job?.notifyConfig?.channels ?? []);
  const [notifyStates, setNotifyStates] = useState<JobRunState[]>(job?.notifyConfig?.states ?? ["failed"]);
  const [saving, setSaving] = useState(false);

  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [triggerCatalog, setTriggerCatalog] = useState<JobTriggerEvent[]>([]);
  const [otherJobs, setOtherJobs] = useState<JobView[]>([]);

  useEffect(() => {
    void (async () => {
      const [srv, chn, trg, jobs] = await Promise.all([
        systemApi.listServers().catch(() => [] as ServerInfo[]),
        notificationsApi.listChannels().then((r) => r.channels).catch(() => [] as NotificationChannel[]),
        jobsApi.triggerEvents().then((r) => r.data).catch(() => [] as JobTriggerEvent[]),
        jobsApi.list().then((r) => r.data ?? []).catch(() => [] as JobView[]),
      ]);
      setServers(srv);
      setChannels(chn);
      setTriggerCatalog(trg);
      setOtherJobs(jobs.filter((x) => x.kind === "custom" && x.key !== job?.key));
    })();
  }, [job?.key]);

  const canSave = useMemo(() => {
    if (!label.trim() || !command.trim() || serverIds.length === 0 || saving) return false;
    if (scheduleType === "recurring" && !cron.trim()) return false;
    if (scheduleType === "once" && !runAt) return false;
    return true;
  }, [label, command, serverIds, saving, scheduleType, cron, runAt]);

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const payload: JobInput = {
        label: label.trim(),
        command: command.trim(),
        scheduleType,
        serverIds,
        ...(scheduleType === "recurring" ? { cronExpression: cron.trim() } : {}),
        ...(scheduleType === "once" ? { runAt: new Date(runAt).toISOString() } : {}),
        ...(timeoutSec.trim() ? { timeoutMs: Math.max(1, parseInt(timeoutSec, 10)) * 1000 } : {}),
        ...(parseInt(maxAttempts, 10) > 1
          ? { retry: { maxAttempts: parseInt(maxAttempts, 10), backoffSeconds: Math.max(0, parseInt(backoffSec, 10) || 0) } }
          : {}),
        env: rowsToMap(envRows),
        ...(editSecrets ? { secrets: rowsToMap(secretRows) } : {}),
        dependsOn,
        triggerEvents: triggerIds,
        notifyConfig: notifyChannels.length ? { channels: notifyChannels, states: notifyStates } : null,
      };
      const res = editing ? await jobsApi.update(job!.key, payload) : await jobsApi.create(payload);
      onSaved(res.data);
    } catch (err) {
      showToast(getApiErrorMessage(err, j.toast.createFailed), "error", j.toast.title);
    } finally {
      setSaving(false);
    }
  };

  const toggle = <T,>(list: T[], v: T, set: (n: T[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const importEnv = (text: string) => {
    const parsed = parseDotenv(text);
    if (parsed.length === 0) return showToast(c.envPasteEmpty, "error", j.toast.title);
    setEnvRows((prev) => mergeEnv(prev, parsed));
  };
  const pasteEnv = async () => {
    try {
      importEnv(await navigator.clipboard.readText());
    } catch {
      showToast(c.envPasteEmpty, "error", j.toast.title);
    }
  };

  const scheduleRecap =
    scheduleType === "recurring" ? cron : scheduleType === "once" ? runAt || c.summary.none : c.scheduleTypes.manual;
  const retryRecap =
    parseInt(maxAttempts, 10) > 1
      ? `${maxAttempts}×${parseInt(backoffSec, 10) > 0 ? ` · ${backoffSec}s` : ""}`
      : c.summary.retryOff;

  return (
    <div className="grid grid-cols-1 gap-6 pb-24 lg:grid-cols-[1fr_360px]">
      {/* ── Left: form ── */}
      <div className="min-w-0 space-y-5">
        {/* Basics */}
        <Section title={c.sections.basics} icon={Terminal} tone={SECTION_TONES.basics}>
          <Field label={c.name}>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={c.namePlaceholder} className={inputCls} autoFocus />
          </Field>
          <Field label={c.command}>
            <textarea value={command} onChange={(e) => setCommand(e.target.value)} placeholder={c.commandPlaceholder} rows={3} spellCheck={false}
              className={`${inputCls} resize-y font-mono text-sm`} />
            <p className="mt-1.5 text-xs text-muted-foreground/60">{c.commandHint}</p>
          </Field>
        </Section>

        {/* Schedule */}
        <Section title={c.sections.schedule} icon={CalendarClock} tone={SECTION_TONES.schedule}>
          <div className="grid grid-cols-3 gap-2">
            {(["recurring", "once", "manual"] as const).map((st) => (
              <button key={st} type="button" onClick={() => setScheduleType(st)}
                className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${scheduleType === st ? "border-primary/60 bg-primary/10 text-foreground" : "border-border/60 text-muted-foreground hover:bg-muted/50"}`}>
                {c.scheduleTypes[st]}
              </button>
            ))}
          </div>
          {scheduleType === "recurring" && (
            <Field label={c.schedule}>
              <input value={cron} onChange={(e) => setCron(e.target.value)} spellCheck={false} className={`${inputCls} font-mono text-sm`} />
              <p className="mt-1.5 text-xs text-muted-foreground/60">{j.cronHint}</p>
            </Field>
          )}
          {scheduleType === "once" && (
            <Field label={c.runAt}><input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} className={inputCls} /></Field>
          )}
          {scheduleType === "manual" && <p className="text-sm text-muted-foreground/70">{c.manualHint}</p>}
        </Section>

        {/* Environment + secrets (right after Schedule) */}
        <Section title={c.sections.environment} icon={KeyRound} tone={SECTION_TONES.environment}>
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-muted-foreground">{c.env}</span>
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={() => void pasteEnv()} className={ghostBtn}>
                  <FileText className="size-3.5" /> {c.pasteEnv}
                </button>
                <button type="button" onClick={() => envFileRef.current?.click()} className={ghostBtn}>
                  <Upload className="size-3.5" /> {c.uploadEnv}
                </button>
                <input ref={envFileRef} type="file" accept=".env,text/plain" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then(importEnv); e.target.value = ""; }} />
              </div>
            </div>
            <KeyValueEditor rows={envRows} setRows={setEnvRows} addLabel={c.addVar} />
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">{c.secrets}</span>
              {editing && !editSecrets && (
                <button type="button" onClick={() => { setEditSecrets(true); setSecretRows([]); }} className="text-xs font-medium text-primary hover:underline">{c.replaceSecrets}</button>
              )}
            </div>
            {editing && !editSecrets ? (
              <p className="text-xs text-muted-foreground/60">{secretRows.length ? `${secretRows.length} ${c.secretsSet}` : c.noSecrets}</p>
            ) : (
              <KeyValueEditor rows={secretRows} setRows={setSecretRows} addLabel={c.addSecret} secret />
            )}
          </div>
        </Section>

        {/* Servers */}
        <Section title={c.sections.servers} icon={ServerIcon} tone={SECTION_TONES.servers}>
          {servers.length === 0 ? (
            <p className="text-sm text-muted-foreground/60">{c.noServers}</p>
          ) : (
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {servers.map((s) => (
                <Choice key={s.id} checked={serverIds.includes(s.id)} onToggle={() => toggle(serverIds, s.id, setServerIds)} label={s.name || s.sshHost} />
              ))}
            </div>
          )}
        </Section>

        {/* Reliability */}
        <Section title={c.sections.reliability} icon={ShieldCheck} tone={SECTION_TONES.reliability}>
          <div className="grid grid-cols-3 gap-3">
            <Field label={c.timeout}><input value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} inputMode="numeric" placeholder="300" className={inputCls} /></Field>
            <Field label={c.retryAttempts}><input value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} inputMode="numeric" className={inputCls} /></Field>
            <Field label={c.retryBackoff}><input value={backoffSec} onChange={(e) => setBackoffSec(e.target.value)} inputMode="numeric" className={inputCls} /></Field>
          </div>
        </Section>

        {/* Dependencies + triggers */}
        <Section title={c.sections.triggers} icon={GitBranch} tone={SECTION_TONES.triggers}>
          {otherJobs.length > 0 && (
            <Field label={c.dependencies}>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {otherJobs.map((o) => (
                  <Choice key={o.key} checked={dependsOn.includes(o.key)} onToggle={() => toggle(dependsOn, o.key, setDependsOn)} label={o.label} />
                ))}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground/60">{c.dependenciesHint}</p>
            </Field>
          )}
          {triggerCatalog.length > 0 && (
            <Field label={c.triggers}>
              <div className="space-y-1">
                {triggerCatalog.map((tg) => (
                  <button key={tg.id} type="button" onClick={() => toggle(triggerIds, tg.id, setTriggerIds)}
                    aria-pressed={triggerIds.includes(tg.id)}
                    className="flex w-full cursor-pointer items-start gap-2 rounded-lg px-1 py-1 text-start text-sm hover:bg-muted/40">
                    <Checkbox checked={triggerIds.includes(tg.id)} size="sm" className="pointer-events-none mt-0.5" />
                    <span><span className="text-foreground">{tg.label}</span> <span className="text-muted-foreground/60">— {tg.description}</span></span>
                  </button>
                ))}
              </div>
            </Field>
          )}
          {/* Custom trigger — not wired yet (fixed event vocabulary); shown as coming soon. */}
          <div className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm opacity-70">
            <Checkbox checked={false} disabled size="sm" aria-label={c.customTriggerSoon} />
            <span className="text-muted-foreground">{c.customTriggerSoon}</span>
            <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{c.comingSoon}</span>
          </div>
        </Section>

        {/* Notifications */}
        <Section title={c.sections.notifications} icon={Bell} tone={SECTION_TONES.notifications}>
          {channels.length === 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground/60">{c.noChannels}</p>
              <a href="/settings?tab=notifications" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                {c.setupChannel} <ArrowRight className="size-3.5" />
              </a>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {channels.map((ch) => (
                  <Choice key={ch.id} checked={notifyChannels.includes(ch.id)} onToggle={() => toggle(notifyChannels, ch.id, setNotifyChannels)}
                    label={`${ch.label} (${ch.kind})`} />
                ))}
              </div>
              {notifyChannels.length > 0 && (
                <div className="mt-3 flex gap-4">
                  {NOTIFY_STATES.map((s) => (
                    <button key={s} type="button" onClick={() => toggle(notifyStates, s, setNotifyStates)}
                      aria-pressed={notifyStates.includes(s)}
                      className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
                      <Checkbox checked={notifyStates.includes(s)} size="sm" className="pointer-events-none" />
                      {j.status[s]}
                    </button>
                  ))}
                </div>
              )}
              <p className="mt-1.5 text-xs text-muted-foreground/60">{c.notificationsHint}</p>
            </>
          )}
        </Section>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-xl border border-border px-5 py-2.5 text-sm font-medium text-foreground hover:bg-muted">{c.cancel}</button>
          <button onClick={() => void submit()} disabled={!canSave}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40">
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            {saving ? c.creating : editing ? j.edit.save : c.submit}
          </button>
        </div>
      </div>

      {/* ── Right: live summary + docs ── */}
      <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        <div className="rounded-2xl border border-border/60 bg-card p-5">
          <div className="mb-4 flex items-center gap-2">
            <ListChecks className="size-4 text-muted-foreground/70" />
            <h3 className="text-[14px] font-medium text-foreground">{c.summary.title}</h3>
          </div>
          <div className="space-y-2.5">
            <SummaryRow label={c.summary.command} value={label.trim() || command.trim() || c.summary.none} mono={!label.trim() && !!command.trim()} />
            <SummaryRow label={c.summary.schedule} value={scheduleRecap} mono={scheduleType === "recurring"} />
            <SummaryRow label={c.summary.targets} value={String(serverIds.length)} />
            <SummaryRow label={c.summary.retry} value={retryRecap} />
            <SummaryRow label={c.summary.timeout} value={timeoutSec.trim() ? `${timeoutSec}s` : c.summary.none} />
            <SummaryRow label={c.summary.notify} value={notifyChannels.length ? String(notifyChannels.length) : c.summary.none} />
          </div>
        </div>
        <a href={DOCS_URL} target="_blank" rel="noreferrer"
          className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card p-4 transition-colors hover:border-border">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
            <BookOpen className="size-[18px] text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{c.docsLink}</p>
            <p className="truncate text-xs text-muted-foreground/70">{c.docsBody}</p>
          </div>
          <ArrowRight className="size-4 shrink-0 text-muted-foreground/40" />
        </a>
      </div>
    </div>
  );
}

function SummaryRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <span className={`min-w-0 truncate text-right text-sm text-foreground ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

/** Distinct colored tone per section — so the icons read like the app catalog /
 *  server pages (colorful) instead of one flat monochrome primary tint. */
const SECTION_TONES: Record<string, { bg: string; text: string }> = {
  basics: { bg: "bg-sky-500/10", text: "text-sky-500" },
  schedule: { bg: "bg-violet-500/10", text: "text-violet-500" },
  environment: { bg: "bg-amber-500/10", text: "text-amber-500" },
  servers: { bg: "bg-emerald-500/10", text: "text-emerald-500" },
  reliability: { bg: "bg-blue-500/10", text: "text-blue-500" },
  triggers: { bg: "bg-fuchsia-500/10", text: "text-fuchsia-500" },
  notifications: { bg: "bg-rose-500/10", text: "text-rose-500" },
};

function Section({
  title,
  icon: Icon,
  tone,
  children,
}: {
  title: string;
  icon?: React.ElementType;
  tone?: { bg: string; text: string };
  children: React.ReactNode;
}) {
  const t = tone ?? { bg: "bg-primary/10", text: "text-primary" };
  return (
    <section className="rounded-2xl border border-border/50 bg-card">
      <div className="flex items-center gap-3 border-b border-border/50 px-5 py-4">
        {Icon && (
          <div className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${t.bg}`}>
            <Icon className={`size-[18px] ${t.text}`} />
          </div>
        )}
        <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
      </div>
      <div className="space-y-4 p-5">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      {label && <span className="mb-1.5 block text-sm font-medium text-muted-foreground">{label}</span>}
      {children}
    </label>
  );
}

function Choice({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={checked}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-start text-sm transition-colors ${checked ? "border-primary/50 bg-primary/5" : "border-border/50 hover:bg-muted/40"}`}
    >
      <Checkbox checked={checked} size="sm" className="pointer-events-none" />
      <span className="truncate text-foreground">{label}</span>
    </button>
  );
}

function KeyValueEditor({ label, rows, setRows, addLabel, secret }: {
  label?: string; rows: KV[]; setRows: (n: KV[]) => void; addLabel: string; secret?: boolean;
}) {
  const set = (i: number, patch: Partial<KV>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <Field label={label}>
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input value={r.key} onChange={(e) => set(i, { key: e.target.value })} placeholder="KEY" className={`${inputCls} font-mono text-sm`} />
            <input value={r.value} onChange={(e) => set(i, { value: e.target.value })} placeholder="value" type={secret ? "password" : "text"} className={`${inputCls} font-mono text-sm`} />
            <button type="button" onClick={() => setRows(rows.filter((_, k) => k !== i))} className="rounded-lg p-1.5 text-muted-foreground hover:bg-danger-bg hover:text-danger"><Trash2 className="size-3.5" /></button>
          </div>
        ))}
        <button type="button" onClick={() => setRows([...rows, { key: "", value: "" }])}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/60 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted/30 hover:text-foreground">
          <Plus className="size-4" /> {addLabel}
        </button>
      </div>
    </Field>
  );
}
