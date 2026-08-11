"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  Pencil,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,  Database,
  Clock,
  HardDrive,
  Star,
} from "lucide-react";
import {
  backupDestinationsApi,
  getApiErrorMessage,
  type DestinationUsage,
  type DestinationUsagePolicy,
} from "@/lib/api";
import { formatBytes } from "@/lib/formatBytes";
import { PageContainer } from "@/components/ui/PageContainer";
import { ResourceNotFound } from "@/components/resource-not-found";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import {
  KIND_ICONS,
  EDITABLE_KINDS,
  kindLabel,
  describeDestination,
  describeCredentials,
} from "@/components/backup/destinationDisplay";
import { CreateDestinationModal } from "../_components/CreateDestinationModal";

export default function BackupDestinationDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { t } = useI18n();
  const m = t.misc.backups;
  const { showToast } = useToast();

  const [usage, setUsage] = useState<DestinationUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await backupDestinationsApi.usage(id);
      setUsage(res.data);
      setNotFound(false);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const dest = usage?.destination;

  const handleVerify = useCallback(async () => {
    if (!dest) return;
    setVerifying(true);
    try {
      const res = await backupDestinationsApi.preflight(dest.id);
      if (res.data.ok) showToast(interpolate(m.verifiedSuccess, { name: dest.name }), "success", m.title);
      else showToast(res.data.reason ?? m.verificationFailedMsg, "error", m.verificationFailedTitle);
    } catch (err) {
      showToast(getApiErrorMessage(err, m.verificationFailedTitle), "error", m.verificationFailedTitle);
    } finally {
      setVerifying(false);
      void load();
    }
  }, [dest, load, showToast, m]);

  if (loading) {
    return (
      <PageContainer>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </PageContainer>
    );
  }

  if (notFound || !dest) {
    return (
      <PageContainer>
        <div className="flex min-h-[60vh] items-center justify-center">
          <ResourceNotFound
            icon={<HardDrive className="size-7" />}
            title={m.notFound}
            actions={[
              {
                href: "/backups",
                label: m.title,
                icon: <ArrowLeft className="size-4 rtl:rotate-180" />,
              },
            ]}
          />
        </div>
      </PageContainer>
    );
  }

  const Icon = KIND_ICONS[dest.kind] ?? HardDrive;
  const canEdit = EDITABLE_KINDS.has(dest.kind);
  const policies = usage.policies;

  return (
    <PageContainer>
      {/* Back */}
      <Link href="/backups" className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4 rtl:rotate-180" /> {m.title}
      </Link>

      {/* Header card */}
      <div className="mb-6 rounded-2xl border border-border/50 bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border/40 bg-foreground/[0.05]">
              <Icon className="size-5 text-foreground/70" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-lg font-semibold text-foreground">{dest.name}</h1>
                {dest.isDefault && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                    <Star className="size-3 fill-current" /> {m.defaultBadge}
                  </span>
                )}
                <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {kindLabel(dest.kind, m)}
                </span>
                {dest.lastVerifiedAt ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-[11px] font-medium text-success">
                    <CheckCircle2 className="size-3" /> {m.verifiedBadge}
                  </span>
                ) : dest.lastVerifyError ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-danger-bg px-2 py-0.5 text-[11px] font-medium text-danger" title={dest.lastVerifyError}>
                    <AlertCircle className="size-3" /> {m.failedBadge}
                  </span>
                ) : (
                  <span className="rounded-full bg-foreground/[0.04] px-2 py-0.5 text-[11px] font-medium text-muted-foreground/70">
                    {m.notVerifiedBadge}
                  </span>
                )}
              </div>
              <p className="mt-1.5 truncate font-mono text-xs text-muted-foreground/80">{describeDestination(dest, m)}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground/70">{describeCredentials(dest, m)}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={handleVerify}
              disabled={verifying}
              className="inline-flex items-center gap-1.5 rounded-lg bg-foreground/[0.06] px-3 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1] disabled:opacity-50"
            >
              {verifying ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              {m.verifyConnection}
            </button>
            {canEdit && (
              <button
                onClick={() => setEditing(true)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-foreground/[0.06] px-3 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
              >
                <Pencil className="size-3.5" /> {m.editAction}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Body: used-by list (left) + storage status (right) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0">
          <div className="mb-3">
            <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground/70">{m.usedBy}</h2>
            <p className="mt-1 text-[12px] text-muted-foreground/60">{m.usedByDesc}</p>
          </div>
          {policies.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/60 px-6 py-16 text-center">
              {/* Backup-destination illustration: stacked snapshot layers with a
                  database glyph and a dashed "add" badge — neutral theme tokens. */}
              <div className="relative mx-auto mb-7 h-32 w-56">
                <svg className="absolute inset-0 h-full w-full" viewBox="0 0 224 132" fill="none">
                  {/* stacked layers */}
                  <rect x="70" y="44" width="112" height="66" rx="13" fill="var(--th-sf-04)" />
                  <rect x="60" y="34" width="112" height="66" rx="13" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
                  <rect x="50" y="24" width="112" height="66" rx="13" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />
                  {/* database glyph on the top layer */}
                  <ellipse cx="82" cy="44" rx="15" ry="5.5" fill="var(--th-sf-05)" stroke="var(--th-on-20)" strokeWidth="1.5" />
                  <path d="M67 44 v20 a15 5.5 0 0 0 30 0 V44" fill="none" stroke="var(--th-on-20)" strokeWidth="1.5" />
                  <path d="M67 54 a15 5.5 0 0 0 30 0" fill="none" stroke="var(--th-on-16)" strokeWidth="1.5" />
                  {/* label lines */}
                  <rect x="108" y="42" width="38" height="6" rx="3" fill="var(--th-on-10)" />
                  <rect x="108" y="56" width="26" height="6" rx="3" fill="var(--th-on-08)" />
                  {/* dashed "add" badge */}
                  <circle cx="176" cy="26" r="15" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="2" strokeDasharray="4 3" />
                  <path d="M176 19 v14 M169 26 h14" stroke="var(--th-on-40)" strokeWidth="2" strokeLinecap="round" />
                  {/* decorative accents */}
                  <circle cx="26" cy="40" r="4" fill="var(--th-on-10)" />
                  <circle cx="36" cy="108" r="6" fill="var(--th-on-08)" />
                  <circle cx="206" cy="98" r="5" fill="var(--th-on-06)" />
                  <path d="M16 92l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
                  <path d="M210 44l1.5-3 1.5 3-3-1.5 3 0-3 1.5z" fill="var(--th-on-12)" />
                </svg>
              </div>
              <p className="text-[15px] font-medium text-foreground/90">{m.noUsageTitle}</p>
              <p className="mt-1.5 mx-auto max-w-sm text-[13px] leading-relaxed text-muted-foreground/70">{m.noUsageDesc}</p>
            </div>
          ) : (
            <div className="rounded-2xl border border-border/50 bg-card">
              <ul className="divide-y divide-border/50">
                {policies.map((p) => (
                  <PolicyRow key={p.policyId} p={p} m={m} />
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Right: storage status */}
        <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-2xl border border-border/50 bg-card p-5">
            <div className="mb-4 flex items-center gap-2">
              <HardDrive className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground">{m.summaryTitle}</h3>
            </div>
            <div className="space-y-3">
              <StatRow icon={Database} label={m.summaryStored} value={formatBytes(dest.stats?.storedBytes ?? 0)} />
              <StatRow icon={Clock} label={m.summaryBackups} value={String(dest.stats?.runCount ?? 0)} />
              <StatRow
                icon={CheckCircle2}
                label={m.statsLast}
                value={dest.stats?.lastRunAt ? new Date(dest.stats.lastRunAt).toLocaleDateString() : "—"}
              />
            </div>
          </div>
        </div>
      </div>

      <CreateDestinationModal
        isOpen={editing}
        destination={editing ? dest : null}
        onClose={() => setEditing(false)}
        onSaved={async () => {
          setEditing(false);
          showToast(m.updated, "success", m.title);
          await load();
        }}
      />
    </PageContainer>
  );
}

function PolicyRow({ p, m }: { p: DestinationUsagePolicy; m: Record<string, string> }) {
  const isMail = p.sourceKind === "mail_server";
  const title = isMail
    ? m.mailServer
    : p.serviceName
      ? `${p.projectName ?? "—"} / ${p.serviceName}`
      : p.projectName ?? "—";
  const href = isMail ? "/emails" : p.projectId ? `/projects/${p.projectId}/backup` : null;
  const schedule = p.cronExpression ?? m.scheduleManual;
  const run = p.lastRun;
  const tone = !run
    ? ""
    : run.status === "succeeded"
      ? "text-success"
      : ["failed", "server_error", "cancelled"].includes(run.status)
        ? "text-danger"
        : "text-warning";
  const RunIcon = !run ? null : run.status === "succeeded" ? CheckCircle2 : ["failed", "server_error", "cancelled"].includes(run.status) ? XCircle : Loader2;

  const inner = (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
          {!isMail && !p.serviceName && (
            <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {m.projectDefault}
            </span>
          )}
          <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
            {p.payloadKind}
          </span>
          {!p.enabled && (
            <span className="rounded-md bg-foreground/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/60">
              off
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground/70">
          <code className="font-mono text-muted-foreground/80">{schedule}</code>
          {run && RunIcon ? (
            <span className={`inline-flex items-center gap-1 ${tone}`}>
              · <RunIcon className={`size-3 ${tone && !["succeeded", "failed", "server_error", "cancelled"].includes(run.status) ? "animate-spin" : ""}`} />
              {run.bytesTransferred ? formatBytes(run.bytesTransferred) : ""}
              <span className="text-muted-foreground/50">{new Date(run.startedAt).toLocaleDateString()}</span>
            </span>
          ) : (
            <span className="italic text-muted-foreground/50">· {m.statsNoRuns}</span>
          )}
        </div>
      </div>
      {href && <ArrowRight className="size-4 shrink-0 text-muted-foreground/30 transition-colors group-hover:text-muted-foreground/60 rtl:rotate-180" />}
    </>
  );

  return (
    <li className="first:rounded-t-2xl last:rounded-b-2xl">
      {href ? (
        <Link href={href} className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-foreground/[0.03]">
          {inner}
        </Link>
      ) : (
        <div className="flex items-center gap-4 px-5 py-3.5">{inner}</div>
      )}
    </li>
  );
}

function StatRow({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <Icon className="size-4 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <span className="shrink-0 text-sm font-semibold text-foreground">{value}</span>
    </div>
  );
}
