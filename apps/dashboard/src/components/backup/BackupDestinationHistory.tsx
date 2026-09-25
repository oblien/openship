"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { isPayloadKind, payloadSpec } from "@repo/core";
import type { BackupDestinationRun } from "@repo/contracts";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { backupDestinationsApi, backupsApi, getApiErrorMessage, type BackupRun } from "@/lib/api";
import { formatBytes } from "@/lib/formatBytes";
import { useBackupDestinationData } from "@/hooks/useBackupDestinationData";
import { Button } from "@/components/ui/button";
import { BackupStatusChip } from "./BackupStatusChip";
import { BackupRunCard } from "./BackupRunCard";
import { RestoreWizard } from "./RestoreWizard";
import { BackupDestinationLoadError } from "./destinationDisplay";

const PAGE_SIZE = 10;
// The parent refreshes storage + history while any destination has active runs,
// including ones outside the page currently being viewed.
const noSeparatePoll = () => false;

export function BackupDestinationHistory({ refreshKey }: { refreshKey: unknown }) {
  const { t, locale } = useI18n();
  const b = t.projectSettings.backup;
  const m = t.misc.backups;
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const before = cursors.at(-1);
  const read = useCallback(
    () => backupDestinationsApi.history({ limit: PAGE_SIZE, before }),
    [before],
  );
  const { data, error, refreshing, reload, refresh } = useBackupDestinationData(
    read,
    noSeparatePoll,
  );
  const lastRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (lastRefreshKey.current === refreshKey) return;
    lastRefreshKey.current = refreshKey;
    void refresh();
  }, [refreshKey, refresh]);

  const [details, setDetails] = useState<BackupDestinationRun | null>(null);
  const [restore, setRestore] = useState<{ run: BackupRun; name: string } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const openingRequest = useRef<symbol | null>(null);
  useEffect(
    () => () => {
      openingRequest.current = null;
    },
    [],
  );
  const sourceName = (run: BackupDestinationRun) =>
    run.serviceName ?? run.mailServerName ?? run.projectName ?? b.overview.serviceBackup;

  const openRestore = async (summary: BackupDestinationRun) => {
    if (openingRequest.current) return;
    const request = Symbol();
    openingRequest.current = request;
    setOpening(summary.id);
    setActionError(null);
    try {
      const result = await backupsApi.getRun(summary.id);
      if (openingRequest.current === request)
        setRestore({ run: result.data, name: sourceName(summary) });
    } catch (error) {
      if (openingRequest.current === request)
        setActionError(getApiErrorMessage(error, b.overview.loadFailed));
    } finally {
      if (openingRequest.current === request) {
        openingRequest.current = null;
        setOpening(null);
      }
    }
  };

  return (
    <>
      <section
        aria-label={b.recent.title}
        className="min-w-0 overflow-hidden rounded-2xl border border-border/50 bg-card"
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4">
          <div>
            <h2 className="text-base font-medium text-foreground">{b.recent.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{m.historyDescription}</p>
          </div>
          {refreshing && data && (
            <Icon
              name="spinner"
              className="mt-1 size-4 shrink-0 animate-spin text-muted-foreground"
            />
          )}
        </div>
        {error != null && (
          <div className="px-5">
            <BackupDestinationLoadError
              error={error}
              retry={() => void reload()}
              busy={refreshing}
            />
          </div>
        )}
        {actionError && (
          <p role="alert" className="px-5 pb-4 text-sm text-danger">
            {actionError}
          </p>
        )}
        {!data && refreshing ? (
          <div aria-busy="true" aria-label={b.recent.loading} className="space-y-3 px-5 pb-5">
            {[0, 1, 2].map((n) => (
              <div key={n} className="h-12 animate-pulse rounded-lg bg-muted/50" />
            ))}
          </div>
        ) : data && data.runs.length === 0 ? (
          <div className="flex items-center gap-4 px-5 py-8">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
              <Icon name="database-backup" className="size-5" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">{b.recent.empty}</p>
              <p className="mt-1 text-sm text-muted-foreground">{m.historyEmptyHint}</p>
            </div>
          </div>
        ) : data ? (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[760px] table-fixed text-start text-xs">
              <colgroup>
                <col className="w-[30%]" />
                <col />
                <col className="w-44" />
                <col className="w-20" />
                <col className="w-40" />
              </colgroup>
              <thead className="border-y border-border/40 bg-muted/20 text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 text-start font-medium" scope="col">
                    {b.recent.backup}
                  </th>
                  <th className="px-3 py-3 text-start font-medium" scope="col">
                    {m.contents}
                  </th>
                  <th className="px-3 py-3 text-start font-medium" scope="col">
                    {t.widgets.backup.runCard.started}
                  </th>
                  <th className="px-3 py-3 text-end font-medium" scope="col">
                    {t.widgets.backup.runCard.bytes}
                  </th>
                  <th className="px-5 py-3" scope="col">
                    <span className="sr-only">{b.recent.viewDetails}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {data.runs.map((run) => {
                  const name = sourceName(run);
                  const contextName = run.projectName ?? run.mailServerName;
                  const source = contextName === name ? null : contextName;
                  const trigger =
                    b.recent.triggers[run.triggeredBy as keyof typeof b.recent.triggers] ??
                    run.triggeredBy;
                  const href = run.projectId
                    ? `/projects/${run.projectId}/backup`
                    : run.mailServerId
                      ? `/emails?serverId=${encodeURIComponent(run.mailServerId)}&tab=backup`
                      : null;
                  const canRestore =
                    run.status === "succeeded" &&
                    !!run.serviceName &&
                    !!run.serviceId &&
                    !!run.projectId;
                  return (
                    <tr key={run.id} className="hover:bg-muted/20">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <span
                            className="truncate text-sm font-medium text-foreground"
                            title={name}
                          >
                            {name}
                          </span>
                          <span className="shrink-0 whitespace-nowrap">
                            <BackupStatusChip status={run.status} />
                          </span>
                        </div>
                        {(source || run.destinationName) && (
                          <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
                            {source &&
                              (href ? (
                                <Link
                                  href={href}
                                  className="truncate hover:text-foreground hover:underline"
                                  title={source}
                                >
                                  {source}
                                </Link>
                              ) : (
                                <span className="truncate" title={source}>{source}</span>
                              ))}
                            {source && run.destinationName && (
                              <span aria-hidden="true">·</span>
                            )}
                            {run.destinationName &&
                              (run.destinationId ? (
                                <Link
                                  href={`/backups/${run.destinationId}`}
                                  className="truncate hover:text-foreground hover:underline"
                                  title={run.destinationName}
                                >
                                  {run.destinationName}
                                </Link>
                              ) : (
                                <span className="truncate" title={run.destinationName}>
                                  {run.destinationName}
                                </span>
                              ))}
                          </div>
                        )}
                        {run.errorMessage && (
                          <p className="mt-0.5 truncate text-danger" title={run.errorMessage}>
                            {run.errorMessage}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <Payloads payloads={run.payloads} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">
                        <time
                          dateTime={run.startedAt}
                          className="block truncate"
                          title={new Date(run.startedAt).toLocaleString(locale)}
                        >
                          {new Date(run.startedAt).toLocaleString(locale, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </time>
                        <p className="mt-0.5 truncate" title={trigger}>
                          {trigger}
                        </p>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-end tabular-nums text-muted-foreground">
                        {run.bytesTransferred === null ? "—" : formatBytes(run.bytesTransferred)}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {canRestore ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="min-w-0"
                              disabled={opening !== null}
                              onClick={() => void openRestore(run)}
                              title={b.recent.restoreTitle}
                            >
                              <Icon
                                name={opening === run.id ? "spinner" : "rotate-left"}
                                className={`size-3.5 shrink-0 ${opening === run.id ? "animate-spin" : ""}`}
                              />
                              <span className="truncate">{b.recent.restore}</span>
                            </Button>
                          ) : (
                            href && (
                              <Link
                                href={href}
                                title={m.viewBackups}
                                aria-label={`${m.viewBackups}: ${name}`}
                                className="rounded-lg p-2 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                              >
                                <Icon name="arrow-right" className="size-4 rtl:rotate-180" />
                              </Link>
                            )
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="shrink-0"
                            title={b.recent.viewDetails}
                            aria-label={`${b.recent.viewDetails}: ${name}`}
                            aria-expanded={details?.id === run.id}
                            onClick={() => setDetails(details?.id === run.id ? null : run)}
                          >
                            <Icon name="activity" className="size-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {(cursors.length > 1 || data?.nextCursor) && (
          <nav
            aria-label={m.historyPages}
            className="flex items-center justify-between gap-3 border-t border-border/40 px-5 py-3 text-xs text-muted-foreground"
          >
            <span>{interpolate(m.historyPage, { page: String(cursors.length) })}</span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={refreshing || cursors.length === 1}
                onClick={() => {
                  setDetails(null);
                  setCursors((old) => old.slice(0, -1));
                }}
              >
                <Icon name="chevron-left" className="size-4 rtl:rotate-180" />
                {t.deployments.pagination.previous}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={refreshing || !data?.nextCursor}
                onClick={() => {
                  if (data?.nextCursor) {
                    setDetails(null);
                    setCursors((old) => [...old, data.nextCursor!]);
                  }
                }}
              >
                {t.deployments.pagination.next}
                <Icon name="chevron-right" className="size-4 rtl:rotate-180" />
              </Button>
            </div>
          </nav>
        )}
      </section>
      {details && (
        <section aria-label={b.recent.viewDetails} className="space-y-2">
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => setDetails(null)}>
              <Icon name="close" className="size-3.5" />
              {t.misc.restoreWizard.close}
            </Button>
          </div>
          <BackupRunCard
            key={details.id}
            runId={details.id}
            serviceName={sourceName(details)}
            onComplete={() => refresh()}
          />
        </section>
      )}
      {restore && (
        <RestoreWizard
          sourceRun={restore.run}
          serviceName={restore.name}
          onClose={() => {
            setRestore(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}

function Payloads({ payloads }: { payloads: BackupDestinationRun["payloads"] }) {
  const { t } = useI18n();
  const m = t.misc.backups;
  const values = [
    ...new Map(payloads.map((p) => [`${p.kind}:${p.volumeTarget}:${p.incremental}`, p])).values(),
  ];
  if (!values.length) return <span className="text-muted-foreground">—</span>;
  const items = (rows: typeof values) =>
    rows.map((payload, index) => (
      <div key={index} className="space-y-0.5">
        <p
          className="truncate text-foreground"
          title={isPayloadKind(payload.kind) ? payloadSpec(payload.kind).label : payload.kind}
        >
          {isPayloadKind(payload.kind) ? payloadSpec(payload.kind).label : payload.kind}
        </p>
        {(payload.volumeTarget || payload.incremental) && (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            {payload.volumeTarget && (
              <span className="truncate" title={payload.volumeTarget}>
                {payload.volumeTarget}
              </span>
            )}
            {payload.volumeTarget && payload.incremental && <span aria-hidden="true">·</span>}
            {payload.incremental && <span className="shrink-0">{m.incremental}</span>}
          </div>
        )}
      </div>
    ));
  return (
    <div className="space-y-0.5">
      {items(values.slice(0, 1))}
      {values.length > 1 && (
        <details>
          <summary className="cursor-pointer rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {interpolate(m.moreContents, { count: String(values.length - 1) })}
          </summary>
          <div className="mt-2 space-y-2">{items(values.slice(1))}</div>
        </details>
      )}
    </div>
  );
}
