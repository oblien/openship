"use client";

import React, { useEffect, useState } from "react";
import { Copy, RefreshCw, Globe, Clock, Calendar, Sparkles, HardDrive, Terminal, ChevronDown } from "lucide-react";
import {
  backupsApi,
  backupDestinationsApi,
  getApiBaseUrl,
  getApiErrorMessage,
  type BackupDestinationSummary,
  type BackupPolicy,
} from "@/lib/api";
import { Modal } from "@/components/ui/Modal";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface Props {
  projectId: string;
  serviceId?: string | null;
  serviceName?: string;
  /** The service's container image — powers the "Detected: Postgres" hint so
   *  the user sees what "Auto" will do. The backend stays the source of truth. */
  serviceImage?: string | null;
  existing?: BackupPolicy | null;
  onClose: () => void;
  onSaved: () => void;
}

type Method = "auto" | "volume" | "custom";

/** Display-only mirror of the server producer registry's image detection
 *  (packages/adapters/src/backup/producers/*). Only powers the hint + summary
 *  label; "auto" is always resolved server-side, so drift here is cosmetic. */
function detectDb(image?: string | null): { label: string; method: string } | null {
  const img = (image ?? "").trim().toLowerCase();
  if (!img) return null;
  if (/^(postgres|postgis\/postgis)([:/]|$)/.test(img)) return { label: "PostgreSQL", method: "pg_dump" };
  if (/^(mysql|mariadb|percona\/percona-server)([:/]|$)/.test(img)) return { label: "MySQL/MariaDB", method: "mysqldump" };
  if (/^redis([:/]|$)/.test(img)) return { label: "Redis", method: "RDB snapshot" };
  if (/^(mongo|percona\/percona-server-mongodb)([:/]|$)/.test(img)) return { label: "MongoDB", method: "mongodump" };
  return null;
}

const methodFromKind = (kind?: string): Method =>
  kind === "volume" ? "volume" : kind === "custom_command" ? "custom" : "auto";

export function PolicyEditor({
  projectId,
  serviceId,
  serviceName,
  serviceImage,
  existing,
  onClose,
  onSaved,
}: Props): React.JSX.Element {
  const { t } = useI18n();
  const w = t.widgets.backup.policyEditor;
  const CRON_PRESETS = [
    { label: w.presetHourly, value: "7 * * * *" },
    { label: w.presetDaily, value: "17 3 * * *" },
    { label: w.presetWeekly, value: "17 3 * * 0" },
    { label: w.presetMonthly, value: "17 3 1 * *" },
    { label: w.presetManual, value: "" },
  ];

  const [destinations, setDestinations] = useState<BackupDestinationSummary[]>([]);
  const [destinationId, setDestinationId] = useState(existing?.destinationId ?? "");
  const [method, setMethod] = useState<Method>(methodFromKind(existing?.payloadKind));
  const [customCommand, setCustomCommand] = useState(
    (existing?.payloadConfig as { command?: string } | undefined)?.command ?? "",
  );
  const [cronExpression, setCronExpression] = useState(existing?.cronExpression ?? "");
  const [triggerOnPreDeploy, setTriggerOnPreDeploy] = useState(existing?.triggerOnPreDeploy ?? false);
  const [enableWebhook, setEnableWebhook] = useState(!!existing?.webhookToken);
  const [retainCount, setRetainCount] = useState<number | "">(existing?.retainCount ?? 7);
  const [retainDays, setRetainDays] = useState<number | "">(existing?.retainDays ?? "");
  const [preHook, setPreHook] = useState(existing?.preHook ?? "");
  const [postHook, setPostHook] = useState(existing?.postHook ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  // Open Advanced by default when an existing policy already uses any of it.
  const [showAdvanced, setShowAdvanced] = useState(
    !!(existing?.triggerOnPreDeploy || existing?.webhookToken || existing?.preHook || existing?.postHook),
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void backupDestinationsApi.list().then((res) => {
      setDestinations(res.data);
      if (!existing && res.data.length > 0 && !destinationId) setDestinationId(res.data[0].id);
    });
  }, [existing, destinationId]);

  const detected = detectDb(serviceImage);
  const webhookUrl = existing?.webhookToken
    ? `${getApiBaseUrl()}webhooks/backup/${existing.webhookToken}`
    : null;

  const methodSummary =
    method === "custom" ? w.summaryCustom
    : method === "volume" ? w.summaryVolume
    : detected ? interpolate(w.summaryLogical, { label: detected.label }) : w.summaryVolume;
  const scheduleSummary =
    cronExpression === ""
      ? w.summaryScheduleManual
      : CRON_PRESETS.find((p) => p.value === cronExpression)?.label ?? cronExpression;
  const destName = destinations.find((d) => d.id === destinationId)?.name ?? "—";
  const retentionSummary =
    [
      retainCount !== "" ? interpolate(w.keepN, { n: String(retainCount) }) : null,
      retainDays !== "" ? interpolate(w.olderThanN, { n: String(retainDays) }) : null,
    ]
      .filter(Boolean)
      .join(" · ") || w.retentionUnlimited;

  const submit = async () => {
    if (!destinationId) {
      window.alert(w.selectDestinationAlert);
      return;
    }
    if (method === "custom" && !customCommand.trim()) {
      window.alert(w.customCommandRequired);
      return;
    }
    setBusy(true);
    try {
      const payload = {
        serviceId: serviceId ?? null,
        destinationId,
        cronExpression: cronExpression || undefined,
        triggerOnPreDeploy,
        enableWebhook,
        retainCount: retainCount === "" ? undefined : Number(retainCount),
        retainDays: retainDays === "" ? undefined : Number(retainDays),
        payloadKind: method === "auto" ? "auto" : method === "volume" ? "volume" : "custom_command",
        payloadConfig: method === "custom" ? { command: customCommand.trim() } : undefined,
        preHook: preHook.trim() || undefined,
        postHook: postHook.trim() || undefined,
        enabled,
      };
      if (existing) await backupsApi.updatePolicy(existing.id, payload);
      else await backupsApi.createPolicy(projectId, payload);
      onSaved();
    } catch (err) {
      window.alert(getApiErrorMessage(err, w.failedSave));
    } finally {
      setBusy(false);
    }
  };

  const rotateToken = async () => {
    if (!existing || !window.confirm(w.rotateConfirm)) return;
    setBusy(true);
    try {
      await backupsApi.updatePolicy(existing.id, { rotateWebhookToken: true });
      onSaved();
    } catch (err) {
      window.alert(getApiErrorMessage(err, w.failedRotate));
    } finally {
      setBusy(false);
    }
  };

  const METHODS: Array<{ id: Method; label: string; desc: string; icon: typeof Sparkles }> = [
    { id: "auto", label: w.methodAuto, desc: w.methodAutoDesc, icon: Sparkles },
    { id: "volume", label: w.methodVolume, desc: w.methodVolumeDesc, icon: HardDrive },
    { id: "custom", label: w.methodCustom, desc: w.methodCustomDesc, icon: Terminal },
  ];

  const inputClass =
    "w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/20 transition-all";

  return (
    <Modal isOpen onClose={onClose} width="920px" maxWidth="95vw" maxHeight="88vh" overflow="hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-border/50 px-6 pt-6 pb-4 pe-12">
        <h2 className="text-lg font-semibold text-foreground">{existing ? w.editTitle : w.createTitle}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {serviceName ? interpolate(w.serviceLabel, { name: serviceName }) : w.projectLevel}
        </p>
      </div>

      {/* Body — 2 columns */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Left: the essentials */}
        <div className="min-h-0 flex-[3] space-y-6 overflow-y-auto px-6 py-5">
          {/* Method — the hero */}
          <div>
            <label className="mb-2 block text-xs font-medium text-foreground/80">{w.methodLabel}</label>
            <div className="grid grid-cols-3 gap-2">
              {METHODS.map((mth) => {
                const active = method === mth.id;
                const Icon = mth.icon;
                return (
                  <button
                    key={mth.id}
                    type="button"
                    onClick={() => setMethod(mth.id)}
                    className={`flex flex-col items-start gap-1.5 rounded-xl border p-3 text-start transition-colors ${
                      active ? "border-primary/60 bg-primary/[0.08]" : "border-border/50 hover:bg-muted/40"
                    }`}
                  >
                    <Icon className={`size-4 ${active ? "text-primary" : "text-muted-foreground"}`} />
                    <span className="text-[13px] font-medium text-foreground">{mth.label}</span>
                    <span className="text-[11px] leading-tight text-muted-foreground">{mth.desc}</span>
                  </button>
                );
              })}
            </div>
            {method === "custom" ? (
              <div className="mt-3">
                <textarea
                  value={customCommand}
                  onChange={(e) => setCustomCommand(e.target.value)}
                  rows={2}
                  placeholder="pg_dump -Fc -U $POSTGRES_USER $POSTGRES_DB"
                  className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/20"
                />
                <p className="mt-1 text-xs text-muted-foreground">{w.customCommandHint}</p>
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                {method === "auto"
                  ? detected
                    ? interpolate(w.detected, { label: detected.label, method: detected.method })
                    : w.autoNoDb
                  : w.volumeHint}
              </p>
            )}
          </div>

          <Field label={w.destination}>
            <select value={destinationId} onChange={(e) => setDestinationId(e.target.value)} className={inputClass}>
              <option value="">{w.selectOption}</option>
              {destinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.kind})
                </option>
              ))}
            </select>
          </Field>

          <Field label={w.schedule}>
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setCronExpression(p.value)}
                    className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                      cronExpression === p.value
                        ? "border-primary/60 bg-primary/10 text-primary"
                        : "border-border/50 text-muted-foreground hover:bg-muted/50"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <input
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder={w.cronPlaceholder}
                className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/20"
              />
            </div>
          </Field>
        </div>

        {/* Right: live summary + retention + advanced */}
        <div className="min-h-0 flex-[2] space-y-5 overflow-y-auto border-t border-border/50 bg-muted/[0.15] px-6 py-5 lg:border-s lg:border-t-0">
          <div className="rounded-xl border border-border/50 bg-card p-4">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {w.summaryTitle}
            </p>
            <dl className="space-y-2.5 text-sm">
              <SummaryRow label={w.summaryMethod} value={methodSummary} />
              <SummaryRow label={w.schedule} value={scheduleSummary} />
              <SummaryRow label={w.destination} value={destName} />
              <SummaryRow label={w.retainCount} value={retentionSummary} />
            </dl>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label={w.retainCount} hint={w.retainCountHint}>
              <input
                type="number"
                value={retainCount}
                onChange={(e) => setRetainCount(e.target.value === "" ? "" : Number(e.target.value))}
                min={1}
                className={inputClass}
              />
            </Field>
            <Field label={w.retainDays} hint={w.retainDaysHint}>
              <input
                type="number"
                value={retainDays}
                onChange={(e) => setRetainDays(e.target.value === "" ? "" : Number(e.target.value))}
                min={1}
                className={inputClass}
              />
            </Field>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex items-center gap-1.5 text-sm font-medium text-foreground/80 transition-colors hover:text-foreground"
            >
              <ChevronDown className={`size-4 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
              {w.advanced}
            </button>

            {showAdvanced && (
              <div className="mt-4 space-y-5">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={triggerOnPreDeploy}
                    onChange={(e) => setTriggerOnPreDeploy(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="text-sm text-foreground/80">
                    <span className="flex items-center gap-1.5 font-medium">
                      <Calendar className="size-3.5" />
                      {w.preDeployTrigger}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{w.preDeployHint}</span>
                  </span>
                </label>

                <div>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={enableWebhook}
                      onChange={(e) => setEnableWebhook(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="text-sm text-foreground/80">
                      <span className="flex items-center gap-1.5 font-medium">
                        <Globe className="size-3.5" />
                        {w.webhookTrigger}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{w.webhookHint}</span>
                    </span>
                  </label>
                  {webhookUrl && (
                    <div className="mt-2 flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 font-mono text-[11px]">
                      <code className="flex-1 truncate">{webhookUrl}</code>
                      <button onClick={() => navigator.clipboard.writeText(webhookUrl)} className="rounded p-1 hover:bg-background" title={w.copyUrl}>
                        <Copy className="size-3" />
                      </button>
                      <button onClick={rotateToken} className="rounded p-1 hover:bg-background" title={w.rotateToken}>
                        <RefreshCw className="size-3" />
                      </button>
                    </div>
                  )}
                </div>

                <Field
                  label={
                    <span className="flex items-center gap-1.5">
                      <Clock className="size-3.5" />
                      {w.preHook}
                    </span>
                  }
                  hint={w.preHookHint}
                >
                  <textarea
                    value={preHook}
                    onChange={(e) => setPreHook(e.target.value)}
                    rows={2}
                    className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/20"
                  />
                </Field>

                <Field label={w.postHook} hint={w.postHookHint}>
                  <textarea
                    value={postHook}
                    onChange={(e) => setPostHook(e.target.value)}
                    rows={2}
                    className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/20"
                  />
                </Field>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 flex items-center justify-between gap-3 border-t border-border/50 px-6 py-4">
        <label className="flex items-center gap-2 text-sm text-foreground/80">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {w.policyEnabled}
        </label>
        <div className="flex items-center gap-2">
          <button onClick={onClose} disabled={busy} className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted">
            {w.cancel}
          </button>
          <button
            onClick={submit}
            disabled={busy || !destinationId}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? w.saving : existing ? w.saveChanges : w.createPolicy}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-end text-[13px] font-medium text-foreground">{value}</dd>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <label className="block text-xs font-medium text-foreground/80">{label}</label>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
