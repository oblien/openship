"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { isPayloadKind, payloadSpec } from "@repo/core";

import React, { useCallback, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  backupDestinationsApi,
  ApiError,
  getApiErrorMessage,
  type DestinationUsage,
  type DestinationUsagePolicy,
} from "@/lib/api";
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
  DestinationVerificationBadge,
  BackupDestinationLoadError,
} from "@/components/backup/destinationDisplay";
import { CreateDestinationModal } from "@/components/backup/CreateDestinationModal";
import { BackupStorageSummary } from "@/components/backup/BackupStorageSummary";
import { Button } from "@/components/ui/button";
import { useBackupDestinationData } from "@/hooks/useBackupDestinationData";

const hasActiveRuns = (usage: DestinationUsage) => (usage.destination.stats?.activeCount ?? 0) > 0;

export default function BackupDestinationDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { t } = useI18n();
  const m = t.misc.backups;
  const { showToast } = useToast();

  const read = useCallback(() => backupDestinationsApi.usage(id), [id]);
  const {
    data: usage,
    error,
    refreshing: loading,
    reload: load,
  } = useBackupDestinationData(read, hasActiveRuns);
  const notFound = error instanceof ApiError && error.status === 404;
  const [verifying, setVerifying] = useState(false);
  const [editing, setEditing] = useState(false);

  const dest = usage?.destination;

  const handleVerify = useCallback(async () => {
    if (!dest) return;
    setVerifying(true);
    try {
      const res = await backupDestinationsApi.preflight(dest.id);
      if (res.data.ok)
        showToast(interpolate(m.verifiedSuccess, { name: dest.name }), "success", m.title);
      else
        showToast(res.data.reason ?? m.verificationFailedMsg, "error", m.verificationFailedTitle);
    } catch (err) {
      showToast(
        getApiErrorMessage(err, m.verificationFailedTitle),
        "error",
        m.verificationFailedTitle,
      );
    } finally {
      setVerifying(false);
      void load();
    }
  }, [dest, load, showToast, m]);

  if (loading && !usage) {
    return (
      <PageContainer>
        <div className="flex items-center justify-center py-20">
          <UiIcon name="spinner" className="size-5 animate-spin text-muted-foreground" />
        </div>
      </PageContainer>
    );
  }

  if (notFound) {
    return (
      <PageContainer>
        <div className="flex min-h-[60vh] items-center justify-center">
          <ResourceNotFound
            icon={<UiIcon name="hard-drive" className="size-7" />}
            title={m.notFound}
            actions={[
              {
                href: "/backups",
                label: m.title,
                icon: <UiIcon name="arrow-left" className="size-4 rtl:rotate-180" />,
              },
            ]}
          />
        </div>
      </PageContainer>
    );
  }

  if (!dest) {
    return (
      <PageContainer>
        <Link
          href="/backups"
          className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <UiIcon name="arrow-left" className="size-4 rtl:rotate-180" /> {m.title}
        </Link>
        {error != null && (
          <BackupDestinationLoadError error={error} retry={() => void load()} busy={loading} />
        )}
      </PageContainer>
    );
  }

  const Icon = KIND_ICONS[dest.kind] ?? "hard-drive";
  const canEdit = EDITABLE_KINDS.has(dest.kind);
  const policies = usage?.policies ?? [];

  return (
    <PageContainer>
      <Link
        href="/backups"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <UiIcon name="arrow-left" className="size-4 rtl:rotate-180" />
        {m.title}
      </Link>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
            <UiIcon name={Icon} className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-medium text-foreground" title={dest.name}>
              {dest.name}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{kindLabel(dest.kind, m)}</span>
              {dest.isDefault && (
                <span className="inline-flex items-center gap-1">
                  <UiIcon name="star" className="size-3" />
                  {m.defaultBadge}
                </span>
              )}
              <DestinationVerificationBadge destination={dest} verifying={verifying} />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void load()}
            disabled={loading}
            aria-label={t.projectSettings.backup.services.refresh}
            title={t.projectSettings.backup.services.refresh}
          >
            <UiIcon name="refresh" className={`size-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button variant="outline" onClick={() => void handleVerify()} disabled={verifying}>
            <UiIcon
              name={verifying ? "spinner" : "check-circle"}
              className={`size-4 ${verifying ? "animate-spin" : ""}`}
            />
            {m.verifyConnection}
          </Button>
          {canEdit && (
            <Button variant="outline" onClick={() => setEditing(true)}>
              <UiIcon name="edit" className="size-4" />
              {m.editAction}
            </Button>
          )}
        </div>
      </div>
      {error != null && (
        <BackupDestinationLoadError error={error} retry={() => void load()} busy={loading} />
      )}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-5">
          <section aria-label={m.usedBy} className="rounded-2xl border border-border/50 bg-card">
            <div className="px-5 py-4">
              <h2 className="text-base font-medium text-foreground">{m.usedBy}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{m.usedByDesc}</p>
            </div>
            {policies.length === 0 ? (
              <div className="px-5 pb-6 pt-2">
                <p className="text-sm font-medium text-foreground">{m.noUsageTitle}</p>
                <p className="mt-1 text-sm text-muted-foreground">{m.noUsageDesc}</p>
              </div>
            ) : (
              <ul className="divide-y divide-border/40 border-t border-border/40">
                {policies.map((p) => (
                  <PolicyRow key={p.policyId} p={p} m={m} />
                ))}
              </ul>
            )}
          </section>
        </div>
        <aside className="space-y-5 xl:sticky xl:top-6">
          <BackupStorageSummary destinations={[dest]} />
          <section
            aria-label={m.destinationDetails}
            className="rounded-2xl border border-border/50 bg-card p-5"
          >
            <h2 className="text-base font-medium text-foreground">{m.destinationDetails}</h2>
            <div className="mt-4 space-y-4 text-sm">
              <div className="flex items-start gap-2.5 text-muted-foreground">
                <UiIcon name={Icon} className="mt-0.5 size-4 shrink-0" />
                <p className="min-w-0 break-words">{describeDestination(dest, m)}</p>
              </div>
              <div className="flex items-start gap-2.5 text-muted-foreground">
                <UiIcon name="lock" className="mt-0.5 size-4 shrink-0" />
                <p>{describeCredentials(dest, m)}</p>
              </div>
              {dest.lastVerifyError && (
                <p className="break-words text-danger">{dest.lastVerifyError}</p>
              )}
            </div>
          </section>
        </aside>
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
  const { t } = useI18n();
  const w = t.widgets.backup.policyEditor;
  const isMail = p.sourceKind === "mail_server";
  const title = isMail
    ? m.mailServer
    : p.serviceName
      ? `${p.projectName ?? "—"} / ${p.serviceName}`
      : (p.projectName ?? "—");
  // Land on the tab that edits THIS policy, the way the project link does.
  // Bare "/emails" dropped an operator on the server list with no hint that the
  // schedule they clicked is two more clicks away.
  const href = isMail
    ? p.mailServerId
      ? `/emails?serverId=${encodeURIComponent(p.mailServerId)}&tab=backup`
      : "/emails"
    : p.projectId
      ? `/projects/${p.projectId}/backup`
      : null;
  const schedule = p.cronExpression ?? m.scheduleManual;
  const method =
    p.payloadKind === "auto"
      ? w.methodAuto
      : isPayloadKind(p.payloadKind)
        ? payloadSpec(p.payloadKind).label
        : p.payloadKind;

  const inner = (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
          {!isMail && !p.serviceId && (
            <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
              {m.projectDefault}
            </span>
          )}
          <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
            {method}
          </span>
          {!p.enabled && (
            <span className="rounded-md bg-foreground/[0.04] px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
              {t.projectSettings.backup.overview.paused}
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <code className="font-mono text-muted-foreground">{schedule}</code>
        </div>
      </div>
      {href && (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground group-hover:text-foreground">
          {m.viewBackups}
          <UiIcon name="arrow-right" className="size-4 rtl:rotate-180" />
        </span>
      )}
    </>
  );

  return (
    <li className="first:rounded-t-2xl last:rounded-b-2xl">
      {href ? (
        <Link
          href={href}
          className="group flex flex-wrap items-center gap-4 px-5 py-4 transition-colors hover:bg-foreground/[0.03]"
        >
          {inner}
        </Link>
      ) : (
        <div className="flex items-center gap-4 px-5 py-3.5">{inner}</div>
      )}
    </li>
  );
}
