"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  DatabaseBackup,
  HardDrive,
  PlayCircle,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  Plus,
  Settings,
  Activity,
  RotateCcw,
  Lock,
  Unlock,
} from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n } from "@/components/i18n-provider";
import {
  backupDestinationsApi,
  backupsApi,
  getApiErrorMessage,
  type BackupDestinationSummary,
  type BackupPolicy,
  type BackupRun,
} from "@/lib/api";
import { PolicyEditor } from "@/components/backup/PolicyEditor";
import { BackupRunCard } from "@/components/backup/BackupRunCard";
import { RestoreWizard } from "@/components/backup/RestoreWizard";

const ICON_TONES = {
  primary: "bg-primary/10 text-primary",
  amber: "bg-warning-bg text-warning",
  emerald: "bg-success-bg text-success",
  red: "bg-danger-bg text-danger",
  muted: "bg-muted/60 text-muted-foreground",
} as const;

function SectionCard({
  title,
  description,
  icon: Icon,
  iconTone,
  actions,
  children,
}: {
  title: string;
  description?: string;
  icon: React.ComponentType<{ className?: string }>;
  iconTone: keyof typeof ICON_TONES;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      <div className="flex items-start gap-3 border-b border-border/40 px-5 py-4">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${ICON_TONES[iconTone]}`}
        >
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
          {description && (
            <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>
          )}
        </div>
        {actions}
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

export function BackupSettings(): React.JSX.Element {
  const { projectData, servicesData } = useProjectSettings();
  const { t } = useI18n();
  const projectId = String(projectData.id);

  const [destinations, setDestinations] = useState<BackupDestinationSummary[]>([]);
  const [policies, setPolicies] = useState<BackupPolicy[]>([]);
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingPolicy, setEditingPolicy] = useState<
    { existing: BackupPolicy | null; serviceId: string | null; serviceName?: string; serviceImage?: string | null } | null
  >(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [restoreFromRun, setRestoreFromRun] = useState<BackupRun | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [destRes, polRes, runRes] = await Promise.all([
        backupDestinationsApi.list(),
        backupsApi.listPolicies(projectId).catch(() => ({ data: [] as BackupPolicy[] })),
        backupsApi.listRuns(projectId, { limit: 25 }).catch(() => ({ data: [] as BackupRun[] })),
      ]);
      setDestinations(destRes.data);
      setPolicies(polRes.data);
      setRuns(runRes.data);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const policyByService = useMemo(() => {
    const map = new Map<string | null, BackupPolicy>();
    for (const p of policies) map.set(p.serviceId, p);
    return map;
  }, [policies]);

  const handleRunNow = useCallback(
    async (policyId: string) => {
      try {
        const res = await backupsApi.runNow(policyId);
        setActiveRunId(res.data.runId);
        await reload();
      } catch (err) {
        window.alert(getApiErrorMessage(err, t.projectSettings.backup.toast.runFailed));
      }
    },
    [reload, t],
  );

  return (
    <div className="space-y-5">
      {activeRunId && (
        <SectionCard
          title={t.projectSettings.backup.live.title}
          description={t.projectSettings.backup.live.description}
          icon={Activity}
          iconTone="primary"
          actions={
            <button
              onClick={() => setActiveRunId(null)}
              className="rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs hover:bg-muted"
            >
              {t.projectSettings.backup.live.dismiss}
            </button>
          }
        >
          <BackupRunCard runId={activeRunId} />
        </SectionCard>
      )}

      {editingPolicy && (
        <PolicyEditor
          projectId={projectId}
          serviceId={editingPolicy.serviceId}
          serviceName={editingPolicy.serviceName}
          serviceImage={editingPolicy.serviceImage}
          existing={editingPolicy.existing}
          onClose={() => setEditingPolicy(null)}
          onSaved={async () => {
            setEditingPolicy(null);
            await reload();
          }}
        />
      )}

      {restoreFromRun && (
        <RestoreWizard
          sourceRun={restoreFromRun}
          serviceName={
            servicesData.services.find((s) => s.id === restoreFromRun.serviceId)?.name
          }
          onClose={() => {
            setRestoreFromRun(null);
            void reload();
          }}
        />
      )}

      <SectionCard
        title={t.projectSettings.backup.destinations.title}
        description={t.projectSettings.backup.destinations.description}
        icon={HardDrive}
        iconTone="primary"
        actions={
          <Link
            href="/backups"
            className="inline-flex items-center gap-1 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs font-medium text-foreground/80 hover:bg-muted"
          >
            {t.projectSettings.backup.destinations.manage} <ExternalLink className="size-3" />
          </Link>
        }
      >
        {loading ? (
          <p className="text-sm text-muted-foreground">{t.projectSettings.backup.destinations.loading}</p>
        ) : destinations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t.projectSettings.backup.destinations.emptyPrefix}<Link href="/backups" className="text-primary hover:underline">{t.projectSettings.backup.destinations.emptyLink}</Link>{t.projectSettings.backup.destinations.emptySuffix}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {destinations.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2 text-sm"
              >
                <div>
                  <span className="font-medium text-foreground">{d.name}</span>
                  <span className="ms-2 text-xs text-muted-foreground">{d.kind}</span>
                </div>
                {d.lastVerifiedAt ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-success">
                    <CheckCircle2 className="size-3" />
                    {t.projectSettings.backup.destinations.verified}
                  </span>
                ) : d.lastVerifyError ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-danger">
                    <XCircle className="size-3" />
                    {t.projectSettings.backup.destinations.failed}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title={t.projectSettings.backup.services.title}
        description={t.projectSettings.backup.services.description}
        icon={DatabaseBackup}
        iconTone="emerald"
        actions={
          <button
            onClick={() => void reload()}
            className="inline-flex items-center gap-1 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs font-medium text-foreground/80 hover:bg-muted"
          >
            <RefreshCw className="size-3" />
            {t.projectSettings.backup.services.refresh}
          </button>
        }
      >
        {servicesData.services.length > 0 &&
          (() => {
            // Project-level policy — one policy that fans out to EVERY service.
            const projectPolicy = policyByService.get(null) ?? null;
            return (
              <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-muted/20 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {t.widgets.backup.policyEditor.projectLevel}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {projectPolicy
                      ? `${t.projectSettings.backup.services.policyLabel} ${projectPolicy.payloadKind}${projectPolicy.cronExpression ? ` · cron ${projectPolicy.cronExpression}` : ` · ${t.projectSettings.backup.services.manualOnly}`}`
                      : t.projectSettings.backup.services.noPolicy}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {projectPolicy ? (
                    <>
                      <button
                        onClick={() => void handleRunNow(projectPolicy.id)}
                        className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                      >
                        <PlayCircle className="size-3" />
                        {t.projectSettings.backup.services.backupNow}
                      </button>
                      <button
                        onClick={() => setEditingPolicy({ existing: projectPolicy, serviceId: null })}
                        className="inline-flex items-center gap-1 rounded-lg bg-muted/50 px-2 py-1.5 text-xs font-medium hover:bg-muted"
                        title={t.projectSettings.backup.services.editPolicy}
                      >
                        <Settings className="size-3" />
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setEditingPolicy({ existing: null, serviceId: null })}
                      disabled={destinations.length === 0}
                      title={
                        destinations.length === 0
                          ? t.projectSettings.backup.services.addDestinationFirst
                          : t.projectSettings.backup.services.createPolicyHint
                      }
                      className="inline-flex items-center gap-1 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Plus className="size-3" />
                      {t.projectSettings.backup.services.createPolicy}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
        {servicesData.services.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t.projectSettings.backup.services.empty}
          </p>
        ) : (
          <ul className="divide-y divide-border/40">
            {servicesData.services.map((svc) => {
              const policy = policyByService.get(svc.id) ?? null;
              return (
                <li key={svc.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{svc.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {policy
                        ? `${t.projectSettings.backup.services.policyLabel} ${policy.payloadKind}${policy.cronExpression ? ` · cron ${policy.cronExpression}` : ` · ${t.projectSettings.backup.services.manualOnly}`}${policy.triggerOnPreDeploy ? ` · ${t.projectSettings.backup.services.preDeploy}` : ""}${policy.webhookToken ? ` · ${t.projectSettings.backup.services.webhook}` : ""}`
                        : t.projectSettings.backup.services.noPolicy}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    {policy ? (
                      <>
                        <button
                          onClick={() => void handleRunNow(policy.id)}
                          className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                        >
                          <PlayCircle className="size-3" />
                          {t.projectSettings.backup.services.backupNow}
                        </button>
                        <button
                          onClick={() =>
                            setEditingPolicy({
                              existing: policy,
                              serviceId: svc.id,
                              serviceName: svc.name,
                              serviceImage: svc.image,
                            })
                          }
                          className="inline-flex items-center gap-1 rounded-lg bg-muted/50 px-2 py-1.5 text-xs font-medium hover:bg-muted"
                          title={t.projectSettings.backup.services.editPolicy}
                        >
                          <Settings className="size-3" />
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() =>
                          setEditingPolicy({
                            existing: null,
                            serviceId: svc.id,
                            serviceName: svc.name,
                            serviceImage: svc.image,
                          })
                        }
                        disabled={destinations.length === 0}
                        title={
                          destinations.length === 0
                            ? t.projectSettings.backup.services.addDestinationFirst
                            : t.projectSettings.backup.services.createPolicyHint
                        }
                        className="inline-flex items-center gap-1 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Plus className="size-3" />
                        {t.projectSettings.backup.services.createPolicy}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title={t.projectSettings.backup.recent.title}
        description={t.projectSettings.backup.recent.description}
        icon={DatabaseBackup}
        iconTone="muted"
      >
        {loading ? (
          <p className="text-sm text-muted-foreground">{t.projectSettings.backup.recent.loading}</p>
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.projectSettings.backup.recent.empty}</p>
        ) : (
          <ul className="divide-y divide-border/40">
            {runs.map((run) => {
              const isSucceeded = run.status === "succeeded";
              const isProtected = !!(run as { retentionLockedUntil?: string | null }).retentionLockedUntil;
              return (
                <li key={run.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusChip status={run.status} />
                      <span className="text-xs text-muted-foreground">
                        {new Date(run.startedAt).toLocaleString()}
                      </span>
                      {run.bytesTransferred ? (
                        <span className="text-xs text-muted-foreground">
                          · {formatBytes(run.bytesTransferred)}
                        </span>
                      ) : null}
                      {isProtected && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-warning-bg px-1.5 py-0.5 text-[10px] text-warning"
                          title={t.projectSettings.backup.recent.protectedTitle}
                        >
                          <Lock className="size-2.5" />
                          {t.projectSettings.backup.recent.protected}
                        </span>
                      )}
                    </div>
                    {run.errorMessage && (
                      <p className="mt-0.5 truncate text-xs text-danger" title={run.errorMessage}>
                        {run.errorMessage}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {isSucceeded && (
                      <button
                        onClick={() => setRestoreFromRun(run)}
                        title={t.projectSettings.backup.recent.restoreTitle}
                        className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <RotateCcw className="size-3.5" />
                      </button>
                    )}
                    {isSucceeded && (
                      <button
                        onClick={async () => {
                          try {
                            await backupsApi.protectRun(run.id, {
                              protected: !isProtected,
                            });
                            await reload();
                          } catch (err) {
                            window.alert(getApiErrorMessage(err, t.projectSettings.backup.toast.toggleProtectionFailed));
                          }
                        }}
                        title={isProtected ? t.projectSettings.backup.recent.allowPrune : t.projectSettings.backup.recent.protectFrom}
                        className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        {isProtected ? <Unlock className="size-3.5" /> : <Lock className="size-3.5" />}
                      </button>
                    )}
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground ms-1">
                      {run.triggeredBy}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function StatusChip({ status }: { status: BackupRun["status"] }): React.JSX.Element {
  const meta = (() => {
    switch (status) {
      case "succeeded":
        return { color: "text-success bg-success-bg", icon: CheckCircle2 };
      case "failed":
      case "server_error":
      case "cancelled":
        return { color: "text-danger bg-danger-bg", icon: XCircle };
      default:
        return { color: "text-info bg-info-bg", icon: Loader2 };
    }
  })();
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.color}`}>
      <Icon className={`size-3 ${status === "succeeded" || status === "failed" || status === "server_error" || status === "cancelled" ? "" : "animate-spin"}`} />
      {status}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
