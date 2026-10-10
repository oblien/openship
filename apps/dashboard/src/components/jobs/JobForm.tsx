"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { formatCpuCores, formatMemoryMb } from "@repo/core";
import {
  jobsApi,
  notificationsApi,
  getApiErrorMessage,
  type JobView,
  type JobTriggerEvent,
  type JobRunState,
} from "@/lib/api";
import type { NotificationChannel } from "@/lib/api/notifications";
import { useToast } from "@/context/ToastContext";
import { usePlatform } from "@/context/PlatformContext";
import { useI18n } from "@/components/i18n-provider";
import { Checkbox } from "@/components/ui/Checkbox";
import { Choice } from "@/components/ui/Choice";
import { useAddServerModal } from "@/components/servers/add-server-modal";
import { useServerDestinations } from "@/hooks/useServerDestinations";
import { Button } from "@/components/ui/button";
import { scopedBillingHref } from "@/lib/billing-links";
import { parseDotenv } from "@/lib/dotenv";
import { actionsApi } from "@/lib/api/actions";
import { useActionResource, useActionScope } from "@/components/actions/useActions";
import { ActionError } from "@/components/actions/ActionStatus";
import { WorkflowInputs, workflowInputDefaults } from "@/components/actions/WorkflowInputs";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Tabs } from "@/components/ui/Tabs";

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
function JobFormContent({
  job,
  initialWorkflowId,
  onSaved,
  onCancel,
}: {
  job?: JobView;
  initialWorkflowId?: string;
  onSaved: (saved: JobView) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const j = t.jobs;
  const c = j.create;
  const { showToast } = useToast();
  const { selfHosted } = usePlatform();
  const editing = !!job;
  const cfg = job?.actionConfig ?? undefined;
  const integration = t.actions.integration;
  const [mode, setMode] = useState<"command" | "workflow">(job?.actionType === "workflow" || initialWorkflowId ? "workflow" : "command");
  const [workflowId, setWorkflowId] = useState(cfg?.workflowId ?? initialWorkflowId ?? "");
  const [workflowInputs, setWorkflowInputs] = useState<Record<string, string>>(cfg?.inputs ?? {});
  const workflowFetcher = useCallback(() => mode === "workflow" ? actionsApi.list() : Promise.resolve([]), [mode]);
  const workflows = useActionResource(workflowFetcher);
  const selectedWorkflow = workflows.data?.find((workflow) => workflow.id === workflowId);
  const dispatchable = !!selectedWorkflow?.enabled && selectedWorkflow.plan.triggers.includes("workflow_dispatch");

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

  const destinations = useServerDestinations();
  const servers = destinations.data?.servers ?? [];
  const openAddServer = useAddServerModal();
  const addServer = () =>
    openAddServer((created) => {
      setServerIds((prev) => (prev.includes(created.id) ? prev : [...prev, created.id]));
      destinations.refresh();
    });
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [triggerCatalog, setTriggerCatalog] = useState<JobTriggerEvent[]>([]);
  const [otherJobs, setOtherJobs] = useState<JobView[]>([]);

  useEffect(() => {
    let active = true;
    setChannels([]);
    setTriggerCatalog([]);
    setOtherJobs([]);
    void (async () => {
      const [chn, trg, jobs] = await Promise.all([
        notificationsApi.listChannels().then((r) => r.channels).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "dashboard/components/jobs/JobForm"); return [] as NotificationChannel[]; }),
        jobsApi.triggerEvents().then((r) => r.data).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "dashboard/components/jobs/JobForm"); return [] as JobTriggerEvent[]; }),
        jobsApi.list().then((r) => r.data ?? []).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "dashboard/components/jobs/JobForm"); return [] as JobView[]; }),
      ]);
      if (!active) return;
      setChannels(chn);
      setTriggerCatalog(trg);
      setOtherJobs(jobs.filter((x) => x.kind === "custom" && x.key !== job?.key));
    })();
    return () => { active = false; };
  }, [job?.key, destinations.organizationId]);

  const canSave = useMemo(() => {
    if (!label.trim() || saving) return false;
    if (mode === "workflow") {
      if (!dispatchable || workflows.loading || workflows.error) return false;
      if (selectedWorkflow?.plan.inputs.some((input) => input.required && !(workflowInputs[input.name] ?? input.default).trim())) return false;
    } else {
      if (!command.trim() || serverIds.length === 0 || destinations.loading || destinations.error) return false;
      if (serverIds.some(id => !servers.some(server => server.id === id && server.managed?.state !== "deleting"))) return false;
    }
    if (scheduleType === "recurring" && !cron.trim()) return false;
    if (scheduleType === "once" && !runAt) return false;
    return true;
  }, [label, mode, dispatchable, workflows.loading, workflows.error, selectedWorkflow, workflowInputs, command, serverIds, saving, scheduleType, cron, runAt, destinations.loading, destinations.error, servers]);

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const payload = {
        label: label.trim(),
        scheduleType,
        ...(mode === "workflow" ? { workflowId, inputs: { ...workflowInputDefaults(selectedWorkflow!.plan.inputs), ...workflowInputs } } : {
        command: command.trim(), serverIds,
        ...(timeoutSec.trim() ? { timeoutMs: Math.max(1, parseInt(timeoutSec, 10)) * 1000 } : {}),
        ...(parseInt(maxAttempts, 10) > 1
          ? { retry: { maxAttempts: parseInt(maxAttempts, 10), backoffSeconds: Math.max(0, parseInt(backoffSec, 10) || 0) } }
          : {}),
        env: rowsToMap(envRows),
        ...(editSecrets ? { secrets: rowsToMap(secretRows) } : {}),
        }),
        ...(scheduleType === "recurring" ? { cronExpression: cron.trim() } : {}),
        ...(scheduleType === "once" ? { runAt: new Date(runAt).toISOString() } : {}),
        dependsOn,
        triggerEvents: triggerIds,
        ...(notifyChannels.length ? { notifyConfig: { channels: notifyChannels, states: mode === "workflow" ? notifyStates.filter((state) => state !== "running") : notifyStates } } : {}),
      };
      const res = editing
        ? await jobsApi.update(job!.key, { ...payload, notifyConfig: payload.notifyConfig ?? null })
        : await jobsApi.create(payload);
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
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "dashboard/components/jobs/JobForm");
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
    <div className="@container"><div className="grid grid-cols-1 items-start gap-6 pb-16 @min-[960px]:grid-cols-[minmax(0,1fr)_340px]">
      {/* ── Left: form ── */}
      <div className="min-w-0 space-y-5">
        {/* Basics */}
        <Section title={c.sections.basics} icon={"terminal"} tone={SECTION_TONES.basics}>
          <Field label={c.name}>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={c.namePlaceholder} className={inputCls} autoFocus />
          </Field>
          {!editing && <Tabs value={mode} onChange={setMode} tabs={[{ key: "command", label: integration.jobCommand }, { key: "workflow", label: integration.jobWorkflow }]} />}
          {mode === "workflow" ? <div className="space-y-4">
            <ActionError message={workflows.error} onRetry={workflows.refresh} />
            <Field label={integration.workflowStep}>
              <CustomSelect variant="filled" triggerClassName="bg-muted/60 hover:bg-muted" value={workflowId}
                placeholder={integration.workflowStep}
                options={(workflows.data ?? []).filter((workflow) => workflow.enabled && workflow.plan.triggers.includes("workflow_dispatch")).map((workflow) => ({ value: workflow.id, label: workflow.name }))}
                onChange={(id) => {
                  setWorkflowId(id);
                  const workflow = workflows.data?.find((entry) => entry.id === id);
                  setWorkflowInputs(workflow ? workflowInputDefaults(workflow.plan.inputs) : {});
                  if (workflow && !label.trim()) setLabel(workflow.name);
                }} />
            </Field>
            <p className="text-xs leading-relaxed text-muted-foreground">{integration.jobHint}</p>
            {selectedWorkflow && <><WorkflowInputs definitions={selectedWorkflow.plan.inputs} values={{ ...workflowInputDefaults(selectedWorkflow.plan.inputs), ...workflowInputs }} onChange={setWorkflowInputs} />
              {!dispatchable && <p role="alert" className="text-sm text-warning">{t.actions.manualHint}</p>}
              <Link href={`/actions/workflows/${workflowId}`} className="inline-flex items-center gap-2 text-sm font-medium hover:underline"><UiIcon name="git-branch" className="size-4" />{selectedWorkflow.name}<UiIcon name="arrow-right" className="size-4 rtl:rotate-180" /></Link>
            </>}
            {!selectedWorkflow && !workflows.loading && <Button asChild size="sm" variant="secondary"><Link href="/actions/new">{t.actions.newWorkflow}</Link></Button>}
          </div> : <Field label={c.command}>
            <textarea value={command} onChange={(e) => setCommand(e.target.value)} placeholder={c.commandPlaceholder} rows={3} spellCheck={false}
              className={`${inputCls} resize-y font-mono text-sm`} />
            <p className="mt-1.5 text-xs text-muted-foreground/60">{c.commandHint}</p>
          </Field>}
        </Section>

        {/* Schedule */}
        <Section title={c.sections.schedule} icon={"calendar-clock"} tone={SECTION_TONES.schedule}>
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

        {mode === "command" && <>
        {/* Environment + secrets (right after Schedule) */}
        <Section title={c.sections.environment} icon={"key"} tone={SECTION_TONES.environment}>
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-muted-foreground">{c.env}</span>
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={() => void pasteEnv()} className={ghostBtn}>
                  <UiIcon name="file-text" className="size-3.5" /> {c.pasteEnv}
                </button>
                <button type="button" onClick={() => envFileRef.current?.click()} className={ghostBtn}>
                  <UiIcon name="upload" className="size-3.5" /> {c.uploadEnv}
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
        <Section title={c.sections.servers} icon={"server"} tone={SECTION_TONES.servers}>
          {!selfHosted && <p className="text-sm text-muted-foreground">{c.cloudServersHint}</p>}
          {destinations.loading ? (
            <div aria-busy="true" aria-label={t.widgets.shared.serverSelector.loadingServers} className="h-12 animate-pulse rounded-xl bg-muted/50" />
          ) : destinations.error ? (
            <div role="alert" className="space-y-2">
              <p className="text-sm text-danger">{destinations.error}</p>
              <Button type="button" variant="secondary" size="sm" onClick={destinations.refresh}>{t.billing.plansRoute.tryAgain}</Button>
            </div>
          ) : servers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{selfHosted ? c.noServers : t.billing.workspaces.noneAvailable}</p>
          ) : (
            <div className="space-y-2">
              {servers.map((server) => {
                const selected = serverIds.includes(server.id);
                const managed = server.managed;
                const resources = managed?.resources;
                return (
                  <div key={server.id} className="space-y-1.5">
                    <Choice checked={selected} onToggle={() => toggle(serverIds, server.id, setServerIds)}
                      disabled={!selected && (managed?.state === "deleting" || server.capabilities?.exec === false)}
                      label={server.name || server.sshHost || server.id}
                      icon={<UiIcon name={managed ? "cloud" : "server"} className="size-4 text-muted-foreground" />}
                      hint={resources ? `${formatCpuCores(resources.cpuCores)} · ${formatMemoryMb(resources.memoryMb)} ${t.deploy.power.ram}` : undefined} />
                    {selected && managed?.state === "needs_plan" && (
                      <Link href={scopedBillingHref("/billing/plans", { workspaceId: managed.id, organizationId: destinations.organizationId })}
                        target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                        {t.billing.onboarding.choosePlan}<UiIcon name="external-link" className="size-3.5" />
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <Button type="button" variant="secondary" size="sm" onClick={addServer}>
            <UiIcon name="plus" className="size-3.5" /> {selfHosted ? t.widgets.shared.serverSelector.addServer : c.addDedicatedServer}
          </Button>
          {!selfHosted && <p className="text-xs text-muted-foreground">{c.cloudUsageHint}</p>}
        </Section>

        {/* Reliability */}
        <Section title={c.sections.reliability} icon={"shield-check"} tone={SECTION_TONES.reliability}>
          <div className="grid grid-cols-3 gap-3">
            <Field label={c.timeout}><input value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} inputMode="numeric" placeholder="300" className={inputCls} /></Field>
            <Field label={c.retryAttempts}><input value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} inputMode="numeric" className={inputCls} /></Field>
            <Field label={c.retryBackoff}><input value={backoffSec} onChange={(e) => setBackoffSec(e.target.value)} inputMode="numeric" className={inputCls} /></Field>
          </div>
        </Section>

        </>}
        {/* Dependencies + triggers */}
        <Section title={c.sections.triggers} icon={"git-branch"} tone={SECTION_TONES.triggers}>
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
                    <Checkbox checked={triggerIds.includes(tg.id)} asButton={false} size="sm" className="pointer-events-none mt-0.5" />
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
        <Section title={c.sections.notifications} icon={"bell"} tone={SECTION_TONES.notifications}>
          {channels.length === 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground/60">{c.noChannels}</p>
              <a href="/settings?tab=notifications" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                {c.setupChannel} <UiIcon name="arrow-right" className="size-3.5" />
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
                  {NOTIFY_STATES.filter((state) => mode !== "workflow" || state !== "running").map((s) => (
                    <button key={s} type="button" onClick={() => toggle(notifyStates, s, setNotifyStates)}
                      aria-pressed={notifyStates.includes(s)}
                      className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
                      <Checkbox checked={notifyStates.includes(s)} asButton={false} size="sm" className="pointer-events-none" />
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
            {saving ? <UiIcon name="spinner" className="size-4 animate-spin" /> : <UiIcon name="check" className="size-4" />}
            {saving ? c.creating : editing ? j.edit.save : c.submit}
          </button>
        </div>
      </div>

      {/* ── Right: live summary + docs ── */}
      <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        <div className="rounded-2xl border border-border/60 bg-card p-5">
          <div className="mb-4 flex items-center gap-2">
            <UiIcon name="list-check" className="size-4 text-muted-foreground/70" />
            <h3 className="text-[14px] font-medium text-foreground">{c.summary.title}</h3>
          </div>
          <div className="space-y-2.5">
            <SummaryRow label={mode === "workflow" ? integration.workflowStep : c.summary.command} value={mode === "workflow" ? selectedWorkflow?.name ?? c.summary.none : label.trim() || command.trim() || c.summary.none} mono={mode === "command" && !label.trim() && !!command.trim()} />
            <SummaryRow label={c.summary.schedule} value={scheduleRecap} mono={scheduleType === "recurring"} />
            {mode === "command" && <>
            <SummaryRow label={c.summary.targets} value={String(serverIds.length)} />
            <SummaryRow label={c.summary.retry} value={retryRecap} />
            <SummaryRow label={c.summary.timeout} value={timeoutSec.trim() ? `${timeoutSec}s` : c.summary.none} />
            </>}
            <SummaryRow label={c.summary.notify} value={notifyChannels.length ? String(notifyChannels.length) : c.summary.none} />
          </div>
        </div>
        <a href={DOCS_URL} target="_blank" rel="noreferrer"
          className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card p-4 transition-colors hover:border-border">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
            <UiIcon name="book" className="size-[18px] text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{c.docsLink}</p>
            <p className="truncate text-xs text-muted-foreground/70">{c.docsBody}</p>
          </div>
          <UiIcon name="arrow-right" className="size-4 shrink-0 text-muted-foreground/40" />
        </a>
      </div>
    </div></div>
  );
}

export function JobForm(props: Parameters<typeof JobFormContent>[0]) {
  const scope = useActionScope();
  return <JobFormContent key={`${scope}:${props.job?.key ?? "new"}`} {...props} />;
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
  icon?: IconName;
  tone?: { bg: string; text: string };
  children: React.ReactNode;
}) {
  const t = tone ?? { bg: "bg-primary/10", text: "text-primary" };
  return (
    <section className="rounded-2xl border border-border/50 bg-card">
      <div className="flex items-center gap-3 border-b border-border/50 px-5 py-4">
        {Icon && (
          <div className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${t.bg}`}>
            <UiIcon name={Icon} className={`size-[18px] ${t.text}`} />
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
            <button type="button" onClick={() => setRows(rows.filter((_, k) => k !== i))} className="rounded-lg p-1.5 text-muted-foreground hover:bg-danger-bg hover:text-danger"><UiIcon name="trash" className="size-3.5" /></button>
          </div>
        ))}
        <button type="button" onClick={() => setRows([...rows, { key: "", value: "" }])}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/60 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted/30 hover:text-foreground">
          <UiIcon name="plus" className="size-4" /> {addLabel}
        </button>
      </div>
    </Field>
  );
}
