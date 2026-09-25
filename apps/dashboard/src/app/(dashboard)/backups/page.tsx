"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useCallback, useState } from "react";
import Link from "next/link";
import {
  backupDestinationsApi,
  type BackupDestinationSummary,
  getApiErrorMessage,
} from "@/lib/api";
import { formatBytes } from "@/lib/formatBytes";
import { PageContainer } from "@/components/ui/PageContainer";
import { Modal } from "@/components/ui/Modal";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { CreateDestinationModal } from "@/components/backup/CreateDestinationModal";
import { BackupStorageSummary } from "@/components/backup/BackupStorageSummary";
import { BackupDestinationHistory } from "@/components/backup/BackupDestinationHistory";
import { Button } from "@/components/ui/button";
import { useBackupDestinationData } from "@/hooks/useBackupDestinationData";
import {
  KIND_ICONS,
  EDITABLE_KINDS,
  kindLabel,
  describeDestination,
  DestinationVerificationBadge,
  BackupDestinationLoadError,
} from "@/components/backup/destinationDisplay";

const readDestinations = () => backupDestinationsApi.list();
const hasActiveRuns = (items: BackupDestinationSummary[]) =>
  items.some((d) => (d.stats?.activeCount ?? 0) > 0);

export default function BackupsPage() {
  const { showToast } = useToast();
  const { t } = useI18n();
  const m = t.misc.backups;
  const {
    data,
    error,
    refreshing: loading,
    reload: load,
  } = useBackupDestinationData(readDestinations, hasActiveRuns);
  const items = data ?? [];
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<BackupDestinationSummary | null>(null);
  const [verifyingIds, setVerifyingIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<BackupDestinationSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const handleVerify = useCallback(
    async (row: BackupDestinationSummary) => {
      setVerifyingIds((prev) => new Set(prev).add(row.id));
      try {
        const res = await backupDestinationsApi.preflight(row.id);
        if (res.data.ok) {
          showToast(interpolate(m.verifiedSuccess, { name: row.name }), "success", m.title);
        } else {
          showToast(res.data.reason ?? m.verificationFailedMsg, "error", m.verificationFailedTitle);
        }
      } catch (err) {
        showToast(
          getApiErrorMessage(err, m.verificationFailedTitle),
          "error",
          m.verificationFailedTitle,
        );
      } finally {
        setVerifyingIds((prev) => {
          const next = new Set(prev);
          next.delete(row.id);
          return next;
        });
        void load();
      }
    },
    [load, showToast, m],
  );

  const handleSetDefault = useCallback(
    async (row: BackupDestinationSummary) => {
      try {
        await backupDestinationsApi.update(row.id, { isDefault: true });
        showToast(interpolate(m.setDefaultSuccess, { name: row.name }), "success", m.title);
        await load();
      } catch (err) {
        showToast(getApiErrorMessage(err, m.setDefaultFailed), "error", m.title);
      }
    },
    [load, showToast, m],
  );

  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await backupDestinationsApi.delete(deleting.id);
      showToast(interpolate(m.deletedSuccess, { name: deleting.name }), "success", m.title);
      setDeleting(null);
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, m.deleteFailed), "error", m.title);
    } finally {
      setDeleteBusy(false);
    }
  }, [deleting, load, showToast, m]);

  return (
    <PageContainer>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium text-foreground">{m.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{m.subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
          <Button onClick={() => setModalOpen(true)}>
            <UiIcon name="plus" className="size-4" />
            {m.addDestination}
          </Button>
        </div>
      </div>

      {error != null && (
        <BackupDestinationLoadError error={error} retry={() => void load()} busy={loading} />
      )}
      {loading && !data ? (
        <div aria-busy="true" className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="h-72 animate-pulse rounded-2xl bg-muted/50" />
          <div className="h-52 animate-pulse rounded-2xl bg-muted/50" />
        </div>
      ) : data ? (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 space-y-5">
            <BackupDestinationHistory refreshKey={data} />
            <section
              aria-label={t.projectSettings.backup.destinations.title}
              className="rounded-2xl border border-border/50 bg-card"
            >
              <div className="px-5 py-4">
                <h2 className="text-base font-medium text-foreground">
                  {t.projectSettings.backup.destinations.title}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{m.destinationsDescription}</p>
              </div>
              {items.length === 0 ? (
                <div className="flex items-center gap-4 px-5 pb-6 pt-3">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
                    <UiIcon name="hard-drive" className="size-5" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">{m.emptyTitle}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{m.emptyDescription}</p>
                  </div>
                </div>
              ) : (
                <ul className="divide-y divide-border/40 border-t border-border/40">
                  {items.map((row) => {
                    const icon = KIND_ICONS[row.kind] ?? "cloud";
                    const actions: MenuAction[] = [];
                    if (EDITABLE_KINDS.has(row.kind))
                      actions.push({
                        id: "edit",
                        label: m.editAction,
                        icon: <UiIcon name="edit" className="size-4" />,
                        onClick: () => setEditing(row),
                      });
                    if (!row.isDefault)
                      actions.push({
                        id: "default",
                        label: m.setDefaultAction,
                        icon: <UiIcon name="star" className="size-4" />,
                        onClick: () => handleSetDefault(row),
                      });
                    if (actions.length) actions.push({ id: "div", divider: true });
                    actions.push({
                      id: "delete",
                      label: m.deleteAction,
                      icon: <UiIcon name="trash" className="size-4" />,
                      variant: "danger",
                      onClick: () => setDeleting(row),
                    });
                    return (
                      <li
                        key={row.id}
                        className="group relative flex items-start gap-3 px-5 py-4 transition-colors hover:bg-muted/20 last:rounded-b-2xl"
                      >
                        <Link
                          href={`/backups/${row.id}`}
                          aria-label={row.name}
                          className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                        <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
                          <UiIcon name={icon} className="size-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-medium text-foreground">
                              {row.name}
                            </p>
                            {row.isDefault && (
                              <span
                                className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                                title={m.defaultTitle}
                              >
                                <UiIcon name="star" className="size-3" />
                                {m.defaultBadge}
                              </span>
                            )}
                            <DestinationVerificationBadge
                              destination={row}
                              verifying={verifyingIds.has(row.id)}
                            />
                          </div>
                          <p
                            className="mt-1 truncate text-xs text-muted-foreground"
                            title={describeDestination(row, m)}
                          >
                            {kindLabel(row.kind, m)} · {describeDestination(row, m)}
                          </p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                            {row.stats && row.stats.runCount > 0 ? (
                              <>
                                <span>
                                  {formatBytes(row.stats.storedBytes)} {m.statsStored}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span>
                                  {row.stats.savedCount !== undefined
                                    ? `${row.stats.savedCount} ${m.statsBackups}`
                                    : `${row.stats.runCount} ${m.statsRuns}`}
                                </span>
                                {(row.stats.activeCount ?? 0) > 0 && (
                                  <span className="text-info">
                                    · {row.stats.activeCount} {m.summaryActive}
                                  </span>
                                )}
                                {(row.stats.failedCount ?? 0) > 0 && (
                                  <span className="text-danger">
                                    · {row.stats.failedCount} {m.summaryFailed}
                                  </span>
                                )}
                              </>
                            ) : (
                              <span>{m.statsNoRuns}</span>
                            )}
                          </div>
                          {row.lastVerifyError && (
                            <p
                              className="mt-1 truncate text-xs text-danger"
                              title={row.lastVerifyError}
                            >
                              {row.lastVerifyError}
                            </p>
                          )}
                        </div>
                        <div className="relative z-10 flex shrink-0 items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => void handleVerify(row)}
                            disabled={verifyingIds.has(row.id)}
                            title={m.verifyConnection}
                            aria-label={`${m.verifyConnection}: ${row.name}`}
                          >
                            <UiIcon
                              name={verifyingIds.has(row.id) ? "spinner" : "refresh"}
                              className={`size-4 ${verifyingIds.has(row.id) ? "animate-spin" : ""}`}
                            />
                          </Button>
                          <DropdownMenu align="right" actions={actions} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
          <aside className="space-y-5 xl:sticky xl:top-6">
            <BackupStorageSummary destinations={items} showDestinationCount />
          </aside>
        </div>
      ) : null}

      <CreateDestinationModal
        isOpen={modalOpen || !!editing}
        destination={editing}
        onClose={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        onSaved={async () => {
          const wasEdit = !!editing;
          setModalOpen(false);
          setEditing(null);
          showToast(wasEdit ? m.updated : m.created, "success", m.title);
          await load();
        }}
      />

      {/* Delete confirmation */}
      {deleting && (
        <Modal
          isOpen
          onClose={() => !deleteBusy && setDeleting(null)}
          maxWidth="440px"
          width="100%"
        >
          <div className="p-6">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-danger-bg">
                <UiIcon name="trash" className="size-5 text-danger" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-foreground">{m.deleteTitle}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {m.deletePre}
                  <span className="font-medium text-foreground">{deleting.name}</span>
                  {m.deletePost}
                </p>
              </div>
            </div>
            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                onClick={() => setDeleting(null)}
                disabled={deleteBusy}
                className="h-10 inline-flex items-center rounded-xl px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
              >
                {m.cancel}
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleteBusy}
                className="h-10 inline-flex items-center gap-2 rounded-xl bg-danger-solid px-5 text-sm font-medium text-white transition-colors hover:bg-danger-solid/90 disabled:opacity-50"
              >
                {deleteBusy ? (
                  <UiIcon name="spinner" className="size-4 animate-spin" />
                ) : (
                  <UiIcon name="trash" className="size-4" />
                )}
                {m.deleteAction}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </PageContainer>
  );
}
