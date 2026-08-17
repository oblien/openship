"use client";

/**
 * Backup tab — backs up the mail server through openship's GENERAL backup
 * system (same policy → orchestrator → destination pipeline as service
 * backups). The mail server is just a new backup SOURCE; destinations
 * ("download on my server" = an openship_server destination) are managed
 * on the shared /backups page and reused here.
 *
 * The include-checkboxes map to the policy's payloadConfig:
 *   - Accounts, domains & aliases   (always — the vmail dump)
 *   - Mailbox message data          (the /var/vmail maildirs; large)
 *   - DKIM keys & secrets           (DKIM + config + mail-state.json)
 *
 * Schedule and retention are the same two knobs a project policy has, because
 * this writes the same `backup_policy` row: the schedule becomes a recurring
 * JobRunner job (visible in /jobs) and retention is what the daily prune reads.
 * They're edited here rather than on /backups so an operator configuring mail
 * never has to leave the mail surface — only *destinations* are shared state,
 * and those keep their "Manage" link out to the page that owns them.
 */

import { useCallback, useEffect, useState } from "react";
import { Checkbox } from "@/components/ui/Checkbox";
import { CustomSelect } from "@/components/ui/CustomSelect";
import Link from "next/link";
import {
  DatabaseBackup,
  HardDrive,
  History,
  Loader2,
  Play,
  Save,
  ShieldAlert,
  Check,
  CircleX,
  Clock,
  ArrowRight,
  ArrowUpRight,
} from "lucide-react";
import { DEFAULT_RETAIN_COUNT } from "@repo/core";
import {
  mailAdminApi,
  backupDestinationsApi,
  backupsApi,
  getApiErrorMessage,
  type BackupDestinationSummary,
  type BackupRun,
  type MailBackupPolicy,
} from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";
import {
  cronFromParts,
  partsFromCron,
  DEFAULT_SCHEDULE_PARTS,
  MAX_DAY_OF_MONTH,
  type BackupFrequency,
  type ScheduleParts,
} from "@/lib/backup-schedule";
import { useMailRailOwnsTabs } from "../../_lib/mail-section";
import { SectionCard } from "./_shared/section-card";
import { MailRestoreModal } from "./mail-restore-modal";

const FREQUENCIES: BackupFrequency[] = ["manual", "daily", "weekly", "monthly", "custom"];

/** Sunday-first, matching cron's day-of-week numbering. Index = the cron field. */
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const DAYS_OF_MONTH = Array.from({ length: MAX_DAY_OF_MONTH }, (_, i) => i + 1);

const inputClass =
  "w-full px-3 py-2 text-sm rounded-xl border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40";

/**
 * Empty box = no limit. Anything not a positive integer is also no limit rather
 * than a number the API stores and the prune pass then has to defend against.
 */
function parseRetention(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function BackupTab({ serverId, domain }: { serverId: string; domain: string }) {
  const { showToast } = useToast();
  const { t } = useI18n();
  // Heading lives in the page header in mail view — see ../../_lib/mail-section.
  const hoisted = useMailRailOwnsTabs(serverId);
  const [restoreTarget, setRestoreTarget] = useState<{
    run: BackupRun;
    mode: "in_place" | "to_fork";
  } | null>(null);

  const [destinations, setDestinations] = useState<BackupDestinationSummary[]>([]);
  const [policy, setPolicy] = useState<MailBackupPolicy | null>(null);
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [destinationId, setDestinationId] = useState("");
  const [messageData, setMessageData] = useState(false);
  const [keys, setKeys] = useState(true);
  const [schedule, setSchedule] = useState<ScheduleParts>(DEFAULT_SCHEDULE_PARTS);
  // Kept as strings: an empty box is "no limit", which a number state can't hold
  // without conflating it with 0.
  const [retainCount, setRetainCount] = useState(String(DEFAULT_RETAIN_COUNT));
  const [retainDays, setRetainDays] = useState("");
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [destRes, polRes, runsRes] = await Promise.all([
        backupDestinationsApi.list().catch(() => ({ data: [] as BackupDestinationSummary[] })),
        mailAdminApi.backup.getPolicy(serverId).catch(() => ({ policy: null })),
        mailAdminApi.backup.listRuns(serverId).catch(() => ({ runs: [] as BackupRun[] })),
      ]);
      setDestinations(destRes.data);
      setRuns(runsRes.runs);
      const pol = polRes.policy;
      setPolicy(pol);
      if (pol) {
        setDestinationId(pol.destinationId);
        setMessageData(pol.payloadConfig?.mail?.messageData === true);
        setKeys(pol.payloadConfig?.mail?.keys !== false);
        setSchedule(partsFromCron(pol.cronExpression));
        setRetainCount(pol.retainCount == null ? "" : String(pol.retainCount));
        setRetainDays(pol.retainDays == null ? "" : String(pol.retainDays));
      } else if (destRes.data[0]) {
        setDestinationId(destRes.data[0].id);
      }
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (): Promise<MailBackupPolicy | null> => {
    if (!destinationId) {
      showToast(t.emailsAdmin.backup.pickDest, "error", t.emailsAdmin.backup.toastTitle);
      return null;
    }
    const cronExpression = cronFromParts(schedule);
    // A blank custom box legitimately means "no schedule". A blank *time* on a
    // daily/weekly/monthly schedule doesn't — saving it would quietly drop the
    // operator back to manual, which reads as "the schedule didn't stick".
    if (!cronExpression && schedule.frequency !== "manual" && schedule.frequency !== "custom") {
      showToast(t.emailsAdmin.backup.scheduleIncomplete, "error", t.emailsAdmin.backup.toastTitle);
      return null;
    }
    setSaving(true);
    try {
      const { policy: saved } = await mailAdminApi.backup.savePolicy(serverId, {
        destinationId,
        messageData,
        keys,
        cronExpression,
        // Always explicit, both of them: the API reads omitted as "keep what's
        // stored", and this form shows the operator the whole truth, so an
        // emptied box has to travel as null rather than as silence.
        retainCount: parseRetention(retainCount),
        retainDays: parseRetention(retainDays),
      });
      setPolicy(saved);
      // Round-trip what the server actually stored, so a cron it normalized (or
      // a retention value it clamped) shows here instead of the local guess.
      setSchedule(partsFromCron(saved.cronExpression));
      setRetainCount(saved.retainCount == null ? "" : String(saved.retainCount));
      setRetainDays(saved.retainDays == null ? "" : String(saved.retainDays));
      showToast(t.emailsAdmin.backup.saved, "success", t.emailsAdmin.backup.toastTitle);
      return saved;
    } catch (err) {
      showToast(
        getApiErrorMessage(err, t.emailsAdmin.backup.saveFailed),
        "error",
        t.emailsAdmin.backup.toastTitle,
      );
      return null;
    } finally {
      setSaving(false);
    }
  }, [serverId, destinationId, messageData, keys, schedule, retainCount, retainDays, showToast]);

  const backupNow = useCallback(async () => {
    setRunning(true);
    try {
      // Persist the current selection first so the run reflects the checkboxes.
      const saved = policy ? await save() : await save();
      if (!saved) return;
      await backupsApi.runNow(saved.id);
      showToast(t.emailsAdmin.backup.started, "success", t.emailsAdmin.backup.toastTitle);
      // Give the run a moment to register, then refresh the list.
      setTimeout(() => {
        void mailAdminApi.backup
          .listRuns(serverId)
          .then((r) => setRuns(r.runs))
          .catch(() => {});
      }, 1200);
    } catch (err) {
      showToast(
        getApiErrorMessage(err, t.emailsAdmin.backup.startFailed),
        "error",
        t.emailsAdmin.backup.toastTitle,
      );
    } finally {
      setRunning(false);
    }
  }, [policy, save, serverId, showToast]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const noDestinations = destinations.length === 0;
  const hasRetention = parseRetention(retainCount) !== null || parseRetention(retainDays) !== null;

  return (
    <div className="space-y-5">
      {!hoisted && (
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t.emailsAdmin.backup.heading}</h2>
          <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl">
            {t.emailsAdmin.backup.description}
          </p>
        </div>
      )}

      {/* What to include */}
      <SectionCard
        title={t.emailsAdmin.backup.whatTitle}
        description={t.emailsAdmin.backup.whatDesc}
        icon={DatabaseBackup}
      >
        <div className="space-y-3">
          <CheckRow
            checked
            disabled
            onChange={() => {}}
            title={t.emailsAdmin.backup.accountsTitle}
            desc={t.emailsAdmin.backup.accountsDesc}
          />
          <CheckRow
            checked={messageData}
            onChange={setMessageData}
            title={t.emailsAdmin.backup.messageTitle}
            desc={t.emailsAdmin.backup.messageDesc}
          />
          <CheckRow
            checked={keys}
            onChange={setKeys}
            title={t.emailsAdmin.backup.keysTitle}
            desc={t.emailsAdmin.backup.keysDesc}
          />
          {keys && (
            <div className="flex items-start gap-2 rounded-xl border border-warning-border bg-warning-bg px-3.5 py-2.5">
              <ShieldAlert className="size-4 text-warning mt-0.5 shrink-0" />
              <p className="text-xs text-warning leading-relaxed">
                {t.emailsAdmin.backup.keysWarning}
              </p>
            </div>
          )}
        </div>
      </SectionCard>

      {/* Destination + schedule */}
      <SectionCard
        title={t.emailsAdmin.backup.destTitle}
        description={t.emailsAdmin.backup.destDesc}
        icon={HardDrive}
      >
        {noDestinations ? (
          <Link
            href="/backups"
            className="flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-muted/20 px-4 py-3 hover:bg-muted/40 transition-colors"
          >
            <p className="text-sm text-muted-foreground">{t.emailsAdmin.backup.noDest}</p>
            <ArrowRight className="size-4 text-muted-foreground/60 shrink-0 rtl:rotate-180" />
          </Link>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="flex items-baseline justify-between gap-2 mb-1.5">
                  <span className="text-sm font-medium text-foreground">
                    {t.emailsAdmin.backup.destinationLabel}
                  </span>
                  {/* Destinations are shared state owned by /backups — credentials,
                      usage, and every other policy pointing at them live there. */}
                  {destinationId && (
                    <Link
                      href={`/backups/${destinationId}`}
                      className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                    >
                      {t.emailsAdmin.backup.manageDest}
                      <ArrowUpRight className="size-3 rtl:-scale-x-100" />
                    </Link>
                  )}
                </div>
                <CustomSelect
                  value={destinationId}
                  options={destinations.map((d) => ({ value: d.id, label: d.name }))}
                  onChange={setDestinationId}
                />
              </div>
              <div>
                <span className="block text-sm font-medium text-foreground mb-1.5">
                  {t.emailsAdmin.backup.autoLabel}
                </span>
                <CustomSelect
                  value={schedule.frequency}
                  options={FREQUENCIES.map((f) => ({
                    value: f,
                    label: t.emailsAdmin.backup.schedules[f],
                  }))}
                  onChange={(v) =>
                    setSchedule((p) => ({ ...p, frequency: v as BackupFrequency }))
                  }
                />
              </div>
            </div>

            {schedule.frequency !== "manual" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {schedule.frequency === "custom" ? (
                  <label className="block sm:col-span-2">
                    <span className="block text-sm font-medium text-foreground mb-1.5">
                      {t.emailsAdmin.backup.cronLabel}
                    </span>
                    <input
                      type="text"
                      value={schedule.custom}
                      onChange={(e) => setSchedule((p) => ({ ...p, custom: e.target.value }))}
                      placeholder="17 3 * * *"
                      spellCheck={false}
                      dir="ltr"
                      className={`${inputClass} font-mono`}
                    />
                    <span className="block text-xs text-muted-foreground mt-1.5">
                      {t.emailsAdmin.backup.cronHint}
                    </span>
                  </label>
                ) : (
                  <>
                    <label className="block">
                      <span className="block text-sm font-medium text-foreground mb-1.5">
                        {t.emailsAdmin.backup.timeLabel}
                      </span>
                      <input
                        type="time"
                        value={schedule.time}
                        onChange={(e) => setSchedule((p) => ({ ...p, time: e.target.value }))}
                        className={inputClass}
                      />
                      {/* The API host's wall clock, not the browser's — cron is
                          evaluated in the API process's zone. */}
                      <span className="block text-xs text-muted-foreground mt-1.5">
                        {t.emailsAdmin.backup.timeHint}
                      </span>
                    </label>
                    {schedule.frequency === "weekly" && (
                      <div>
                        <span className="block text-sm font-medium text-foreground mb-1.5">
                          {t.emailsAdmin.backup.weekdayLabel}
                        </span>
                        <CustomSelect
                          value={String(schedule.weekday)}
                          options={WEEKDAY_KEYS.map((key, i) => ({
                            value: String(i),
                            label: t.emailsAdmin.backup.weekdays[key],
                          }))}
                          onChange={(v) => setSchedule((p) => ({ ...p, weekday: Number(v) }))}
                        />
                      </div>
                    )}
                    {schedule.frequency === "monthly" && (
                      <div>
                        <span className="block text-sm font-medium text-foreground mb-1.5">
                          {t.emailsAdmin.backup.dayOfMonthLabel}
                        </span>
                        <CustomSelect
                          value={String(schedule.dayOfMonth)}
                          options={DAYS_OF_MONTH.map((d) => ({
                            value: String(d),
                            label: String(d),
                          }))}
                          onChange={(v) => setSchedule((p) => ({ ...p, dayOfMonth: Number(v) }))}
                        />
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {schedule.frequency !== "manual" && (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="size-3.5 shrink-0" />
                {t.emailsAdmin.backup.scheduleJobHint}
                <Link
                  href="/jobs"
                  className="inline-flex items-center gap-0.5 font-medium text-primary hover:text-primary/80 transition-colors"
                >
                  {t.dashboard.nav.jobs}
                  <ArrowUpRight className="size-3 rtl:-scale-x-100" />
                </Link>
              </p>
            )}
          </div>
        )}
      </SectionCard>

      {/* Retention — the same two dimensions a project policy has, read by the
          daily prune sweep. Mail policies used to be skipped by it entirely.
          Pointless with nowhere to back up to, so it follows the destination. */}
      {!noDestinations && (
        <SectionCard
          title={t.emailsAdmin.backup.retentionTitle}
          description={t.emailsAdmin.backup.retentionDesc}
          icon={History}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="block text-sm font-medium text-foreground mb-1.5">
                {t.emailsAdmin.backup.keepCountLabel}
              </span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={retainCount}
                  onChange={(e) => setRetainCount(e.target.value)}
                  placeholder={t.emailsAdmin.backup.retentionNoLimit}
                  className={inputClass}
                />
                <span className="shrink-0 text-sm text-muted-foreground">
                  {t.emailsAdmin.backup.keepCountUnit}
                </span>
              </div>
            </label>
            <label className="block">
              <span className="block text-sm font-medium text-foreground mb-1.5">
                {t.emailsAdmin.backup.keepDaysLabel}
              </span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={retainDays}
                  onChange={(e) => setRetainDays(e.target.value)}
                  placeholder={t.emailsAdmin.backup.retentionNoLimit}
                  className={inputClass}
                />
                <span className="shrink-0 text-sm text-muted-foreground">
                  {t.emailsAdmin.backup.keepDaysUnit}
                </span>
              </div>
            </label>
          </div>
          {!hasRetention && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-warning-border bg-warning-bg px-3.5 py-2.5">
              <ShieldAlert className="size-4 text-warning mt-0.5 shrink-0" />
              <p className="text-xs text-warning leading-relaxed">
                {t.emailsAdmin.backup.retentionUnlimitedWarning}
              </p>
            </div>
          )}
        </SectionCard>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={save}
          disabled={saving || noDestinations || !destinationId}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-xl bg-muted text-foreground hover:bg-muted/80 border border-border transition-colors disabled:opacity-50"
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          {t.emailsAdmin.backup.saveSettings}
        </button>
        <button
          onClick={backupNow}
          disabled={running || noDestinations || !destinationId}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          {t.emailsAdmin.backup.backupNow}
        </button>
      </div>

      {/* Recent runs */}
      <SectionCard title={t.emailsAdmin.backup.recentTitle} icon={Clock} density="split">
        {runs.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            {t.emailsAdmin.backup.noBackups}
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {runs.map((r) => (
              <RunRow key={r.id} run={r} onRestore={(mode) => setRestoreTarget({ run: r, mode })} />
            ))}
          </div>
        )}
      </SectionCard>

      {restoreTarget && (
        <MailRestoreModal
          run={restoreTarget.run}
          mode={restoreTarget.mode}
          sourceServerId={serverId}
          domain={domain}
          onClose={() => setRestoreTarget(null)}
          onDone={() => {
            void mailAdminApi.backup
              .listRuns(serverId)
              .then((r) => setRuns(r.runs))
              .catch(() => {});
          }}
        />
      )}
    </div>
  );
}

function CheckRow({
  checked,
  disabled,
  onChange,
  title,
  desc,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      disabled={disabled}
      aria-pressed={checked}
      className={`flex w-full items-start gap-3 rounded-xl border border-border/60 px-4 py-3 text-start ${
        disabled ? "opacity-70" : "cursor-pointer hover:bg-muted/30"
      } transition-colors`}
    >
      {/* `accent-primary` was the tell: the native box could only be tinted, never themed —
          its border, radius and check glyph stayed the browser's. */}
      <Checkbox checked={checked} disabled={disabled} className="pointer-events-none mt-0.5" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{desc}</p>
      </div>
    </button>
  );
}

function RunRow({
  run,
  onRestore,
}: {
  run: BackupRun;
  onRestore: (mode: "in_place" | "to_fork") => void;
}) {
  const { t } = useI18n();
  const p = runPresentation(run.status);
  return (
    <div className="flex items-center gap-4 px-5 py-3.5">
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${p.bg}`}>
        <p.Icon className={`size-4 ${p.color} ${p.spin ? "animate-spin" : ""}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground capitalize">{run.status}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {new Date(run.startedAt).toLocaleString()}
          {run.errorMessage ? ` · ${run.errorMessage.slice(0, 80)}` : ""}
        </p>
      </div>
      {typeof run.bytesTransferred === "number" && run.bytesTransferred > 0 && (
        <span className="text-xs text-muted-foreground tabular-nums shrink-0">
          {formatBytes(run.bytesTransferred)}
        </span>
      )}
      {run.status === "succeeded" && (
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onRestore("in_place")}
            className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {t.emailsAdmin.backup.restore}
          </button>
          <span className="text-muted-foreground/30">·</span>
          <button
            onClick={() => onRestore("to_fork")}
            className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
          >
            {t.emailsAdmin.backup.migrate}
          </button>
        </div>
      )}
    </div>
  );
}

function runPresentation(status: BackupRun["status"]) {
  if (status === "succeeded")
    return { Icon: Check, bg: "bg-success-bg", color: "text-success", spin: false };
  if (status === "failed" || status === "server_error" || status === "cancelled")
    return { Icon: CircleX, bg: "bg-danger-bg", color: "text-danger", spin: false };
  return { Icon: Loader2, bg: "bg-info-bg", color: "text-info", spin: true };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
