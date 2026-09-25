"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@repo/ui/icons";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import {
  backupDestinationsApi,
  backupsApi,
  getApiErrorMessage,
  type BackupDestinationSummary,
  type BackupPolicy,
  type BackupRun,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import { CreateDestinationModal } from "@/components/backup/CreateDestinationModal";
import { PolicyEditor } from "@/components/backup/PolicyEditor";
import { BackupRunCard } from "@/components/backup/BackupRunCard";
import { BackupStatusChip } from "@/components/backup/BackupStatusChip";
import { RestoreWizard } from "@/components/backup/RestoreWizard";
import { EDITABLE_KINDS, KIND_ICONS, kindLabel, DestinationVerificationBadge } from "@/components/backup/destinationDisplay";
import { partsFromCron } from "@/lib/backup-schedule";
import { formatBytes } from "@/lib/formatBytes";
import { isBackupRunning, latestBackupRun, mergeBackupRuns } from "@/lib/backup-run-state";

type BackupCopy = ReturnType<typeof useI18n>["t"]["projectSettings"]["backup"];
type BackupData = {
  projectId: string;
  destinations: BackupDestinationSummary[];
  policies: BackupPolicy[];
  runs: BackupRun[];
  historyIds: string[];
  hasMore: boolean;
  before: string | null;
};
type PolicyScope = { serviceId: string | null; serviceName: string; serviceImage?: string | null };
const HISTORY_PAGE_SIZE = 10;
const EMPTY: Omit<BackupData, "projectId"> = {
  destinations: [],
  policies: [],
  runs: [],
  historyIds: [],
  hasMore: false,
  before: null,
};

export function BackupSettings(): React.JSX.Element {
  const { projectData, servicesData } = useProjectSettings();
  const { t, locale } = useI18n();
  const b = t.projectSettings.backup;
  const m = t.misc.backups;
  const w = t.widgets.backup.policyEditor;
  const projectId = String(projectData.id);
  const activeProject = useRef<string | null>(projectId);
  activeProject.current = projectId;
  const [data, setData] = useState<BackupData | null>(null);
  const current = data?.projectId === projectId ? data : null;
  const { destinations, policies, runs } = current ?? EMPTY;
  const [refreshing, setRefreshing] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const moreRequest = useRef<symbol | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const pendingActions = useRef(new Set<string>());
  const [busyIds, setBusyIds] = useState(new Set<string>());
  const [destinationEditor, setDestinationEditor] = useState<{
    destination: BackupDestinationSummary | null;
  } | null>(null);
  const [preferredDestination, setPreferredDestination] = useState<BackupDestinationSummary | null>(
    null,
  );
  const [editingPolicy, setEditingPolicy] = useState<
    (PolicyScope & { existing: BackupPolicy | null }) | null
  >(null);
  const [activeRunIds, setActiveRunIds] = useState<string[]>([]);
  const activityRef = useRef<HTMLElement | null>(null);
  const [dismissedRunIds, setDismissedRunIds] = useState(new Set<string>());
  const [restoreFromRun, setRestoreFromRun] = useState<BackupRun | null>(null);

  const reload = useCallback(async () => {
    if (activeProject.current !== projectId) return;
    const version = ++requestVersion.current;
    moreRequest.current = null;
    setLoadingMore(false);
    setHistoryError(null);
    setRefreshing(true);
    setLoadError(null);
    try {
      const [destinations, policies, history, active] = await Promise.all([
        backupDestinationsApi.list(),
        backupsApi.listPolicies(projectId),
        backupsApi.listRuns(projectId, { limit: HISTORY_PAGE_SIZE + 1 }),
        backupsApi.listRuns(projectId, { active: true, limit: 1000 }),
      ]);
      if (version !== requestVersion.current) return;
      const page = history.data.slice(0, HISTORY_PAGE_SIZE);
      const received = mergeBackupRuns(page, active.data);
      setData((previous) => ({
        projectId,
        destinations: destinations.data,
        policies: policies.data,
        runs: received.map(
          (row) =>
            latestBackupRun(
              previous?.projectId === projectId
                ? (previous.runs.find((run) => run.id === row.id) ?? null)
                : null,
              row,
            )!,
        ),
        historyIds: page.map((run) => run.id),
        hasMore: history.data.length > HISTORY_PAGE_SIZE,
        before: page.at(-1)?.id ?? null,
      }));
    } catch (error) {
      if (version === requestVersion.current)
        setLoadError(getApiErrorMessage(error, b.overview.loadFailed));
    } finally {
      if (version === requestVersion.current) setRefreshing(false);
    }
  }, [projectId, b.overview.loadFailed]);

  const loadOlder = async () => {
    if (refreshing || moreRequest.current || !current?.hasMore || !current.before) return;
    const token = Symbol();
    moreRequest.current = token;
    const version = requestVersion.current;
    const before = current.before;
    setLoadingMore(true);
    setHistoryError(null);
    try {
      const response = await backupsApi.listRuns(projectId, {
        limit: HISTORY_PAGE_SIZE + 1,
        before,
      });
      if (activeProject.current !== projectId || version !== requestVersion.current) return;
      const page = response.data.slice(0, HISTORY_PAGE_SIZE);
      setData((previous) =>
        previous?.projectId === projectId && previous.before === before
          ? {
              ...previous,
              runs: mergeBackupRuns(previous.runs, page),
              historyIds: [...new Set([...previous.historyIds, ...page.map((run) => run.id)])],
              hasMore: response.data.length > HISTORY_PAGE_SIZE,
              before: page.at(-1)?.id ?? null,
            }
          : previous,
      );
    } catch (error) {
      if (activeProject.current === projectId && version === requestVersion.current)
        setHistoryError(getApiErrorMessage(error, b.overview.loadFailed));
    } finally {
      if (moreRequest.current === token) {
        moreRequest.current = null;
        setLoadingMore(false);
      }
    }
  };

  const updateRun = useCallback(
    (run: BackupRun) => {
      if (activeProject.current !== projectId) return;
      setData((previous) => {
        if (previous?.projectId !== projectId) return previous;
        const existing = previous.runs.find((row) => row.id === run.id);
        const latest = latestBackupRun(existing ?? null, run)!;
        if (existing === latest) return previous;
        return {
          ...previous,
          runs: existing
            ? previous.runs.map((row) => (row.id === run.id ? latest : row))
            : [latest, ...previous.runs],
          // A newly accepted run may reach its stream before the history request.
          historyIds: existing ? previous.historyIds : [run.id, ...previous.historyIds],
        };
      });
    },
    [projectId],
  );

  useEffect(() => {
    activeProject.current = projectId;
    setEditingPolicy(null);
    setDestinationEditor(null);
    setPreferredDestination(null);
    setActiveRunIds([]);
    setDismissedRunIds(new Set());
    setRestoreFromRun(null);
    setActionError(null);
    void reload();
    return () => {
      activeProject.current = null;
      requestVersion.current += 1;
      moreRequest.current = null;
    };
  }, [reload, projectId]);

  const saveDestination = useCallback(
    (destination: BackupDestinationSummary) => {
      if (activeProject.current !== projectId) return;
      // An older refresh must not remove a destination just created in the modal.
      requestVersion.current += 1;
      setRefreshing(false);
      setData((previous) =>
        previous?.projectId === projectId
          ? {
              ...previous,
              destinations: [
                ...previous.destinations
                  .filter((item) => item.id !== destination.id)
                  .map((item) => (destination.isDefault ? { ...item, isDefault: false } : item)),
                destination,
              ],
            }
          : previous,
      );
      setPreferredDestination(destination);
    },
    [projectId],
  );

  const perform = async (id: string, action: () => Promise<void>, fallback: string) => {
    if (pendingActions.current.has(id)) return;
    pendingActions.current.add(id);
    setBusyIds(new Set(pendingActions.current));
    setActionError(null);
    try {
      await action();
    } catch (error) {
      if (activeProject.current === projectId) setActionError(getApiErrorMessage(error, fallback));
    } finally {
      pendingActions.current.delete(id);
      if (activeProject.current === projectId) setBusyIds(new Set(pendingActions.current));
    }
  };
  const runNow = (policy: BackupPolicy) =>
    perform(
      policy.id,
      async () => {
        const response = await backupsApi.runNow(policy.id);
        if (activeProject.current !== projectId) return;
        setActiveRunIds((previous) => [
          ...new Set([...previous, ...(response.data.runIds ?? [response.data.runId])]),
        ]);
        await reload();
        if (activeProject.current === projectId)
          requestAnimationFrame(() => activityRef.current?.scrollIntoView?.({ block: "nearest" }));
      },
      b.toast.runFailed,
    );

  const finishPolicy = async (policy: BackupPolicy, startBackup = false) => {
    if (activeProject.current !== projectId) return;
    // Keep the saved policy available even if the subsequent refresh or run fails.
    requestVersion.current += 1;
    setRefreshing(false);
    setData((previous) =>
      previous?.projectId === projectId
        ? {
            ...previous,
            policies: [...previous.policies.filter((item) => item.id !== policy.id), policy],
          }
        : previous,
    );
    setEditingPolicy(null);
    if (startBackup) await runNow(policy);
    else await reload();
  };

  const policiesByService = useMemo(() => {
    const grouped = new Map<string | null, BackupPolicy[]>();
    for (const policy of policies)
      grouped.set(policy.serviceId, [...(grouped.get(policy.serviceId) ?? []), policy]);
    return grouped;
  }, [policies]);
  const scopes: PolicyScope[] = [
    { serviceId: null, serviceName: b.overview.projectScope },
    ...servicesData.services.map((service) => ({
      serviceId: service.id,
      serviceName: service.name,
      serviceImage: service.image,
    })),
  ];
  for (const serviceId of policiesByService.keys()) {
    if (serviceId && !scopes.some((scope) => scope.serviceId === serviceId))
      scopes.push({ serviceId, serviceName: b.overview.serviceBackup });
  }
  const recentRuns = useMemo(() => {
    const shown = new Set(current?.historyIds);
    return runs
      .filter((run) => shown.has(run.id))
      .sort((a, z) => Date.parse(z.startedAt) - Date.parse(a.startedAt));
  }, [runs, current?.historyIds]);
  const lastSuccess = recentRuns.find((run) => run.status === "succeeded");
  const scheduledCount = policies.filter(
    (policy) => policy.enabled && policy.cronExpression,
  ).length;
  const projectPolicyEnabled = policies.some(
    (policy) => policy.serviceId === null && policy.enabled,
  );
  const runsById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const trackedRunIds = [
    ...new Set([...activeRunIds, ...runs.filter(isBackupRunning).map((run) => run.id)]),
  ].filter(
    (id) => !dismissedRunIds.has(id) || !runsById.has(id) || isBackupRunning(runsById.get(id)!),
  );
  const liveRunIds = trackedRunIds.filter((id) => !dismissedRunIds.has(id));
  const scopeName = (serviceId: string | null) =>
    scopes.find((scope) => scope.serviceId === serviceId)?.serviceName ?? b.overview.serviceBackup;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{m.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{b.overview.description}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void reload()} disabled={refreshing}>
          <Icon name="refresh" className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
          {b.services.refresh}
        </Button>
      </div>
      {(loadError || actionError) && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger"
        >
          <span>{loadError || actionError}</span>
          {loadError && (
            <Button variant="ghost" size="sm" disabled={refreshing} onClick={() => void reload()}>
              {w.retry}
            </Button>
          )}
        </div>
      )}
      {!current ? (
        refreshing && (
          <div
            aria-busy="true"
            aria-label={b.destinations.loading}
            className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]"
          >
            <div className="h-72 animate-pulse rounded-2xl bg-muted/50" />
            <div className="h-52 animate-pulse rounded-2xl bg-muted/50" />
          </div>
        )
      ) : (
        <>
          <dl className="grid grid-cols-2 rounded-2xl border border-border/50 bg-card sm:grid-cols-3">
            <Summary
              className="col-span-2 border-b sm:col-span-1 sm:border-b-0"
              icon="clock"
              label={b.overview.lastBackup}
              value={
                lastSuccess
                  ? formatDate(lastSuccess.finishedAt ?? lastSuccess.startedAt, locale)
                  : b.overview.noRecentBackup
              }
            />
            <Summary
              className="sm:border-s"
              icon="calendar"
              label={b.overview.scheduledPolicies}
              value={String(scheduledCount)}
            />
            <Summary
              className="border-s"
              icon="hard-drive"
              label={b.destinations.title}
              value={String(destinations.length)}
            />
          </dl>
          <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="min-w-0 space-y-5">
              <section
                className="overflow-hidden rounded-2xl border border-border/50 bg-card"
                aria-label={b.recent.title}
              >
                <SectionHeading title={b.recent.title} description={b.recent.description} />
                {recentRuns.length === 0 ? (
                  <div className="flex flex-col items-center px-5 py-12 text-center">
                    <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
                      <Icon name="database-backup" className="size-5" />
                    </div>
                    <p className="text-sm font-medium text-foreground">{b.recent.empty}</p>
                    <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                      {b.recent.emptyHint}
                    </p>
                  </div>
                ) : (
                  <div className="max-h-[480px] overflow-auto">
                    <table className="w-full min-w-[580px] text-start text-xs">
                      <thead className="sticky top-0 z-10 bg-card text-muted-foreground">
                        <tr className="border-b border-border/40">
                          <th scope="col" className="px-5 py-3 text-start font-medium">
                            {b.recent.backup}
                          </th>
                          <th scope="col" className="px-3 py-3 text-start font-medium">
                            {t.widgets.backup.runCard.started}
                          </th>
                          <th scope="col" className="px-3 py-3 text-end font-medium">
                            {t.widgets.backup.runCard.bytes}
                          </th>
                          <th scope="col" className="px-5 py-3">
                            <span className="sr-only">{b.recent.viewDetails}</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/40">
                        {recentRuns.map((run) => {
                          const succeeded = run.status === "succeeded";
                          const protectedRun =
                            !!run.retentionLockedUntil &&
                            Date.parse(run.retentionLockedUntil) > Date.now();
                          return (
                            <tr key={run.id} className="transition-colors hover:bg-muted/20">
                              <td className="max-w-[240px] px-5 py-3.5">
                                <div className="flex items-center gap-1.5 font-medium text-foreground">
                                  <span className="truncate">{scopeName(run.serviceId)}</span>
                                  {protectedRun && (
                                    <Icon
                                      name="lock"
                                      className="size-3 shrink-0 text-warning"
                                      title={b.recent.protectedTitle}
                                    />
                                  )}
                                </div>
                                <div className="mt-1.5">
                                  <BackupStatusChip status={run.status} />
                                </div>
                                {run.errorMessage && (
                                  <p
                                    className="mt-1 max-w-xs truncate text-danger"
                                    title={run.errorMessage}
                                  >
                                    {run.errorMessage}
                                  </p>
                                )}
                              </td>
                              <td className="whitespace-nowrap px-3 py-3.5 text-muted-foreground">
                                <time dateTime={run.startedAt}>
                                  {formatDate(run.startedAt, locale)}
                                </time>
                                <p className="mt-1 text-[11px]">
                                  {b.recent.triggers[run.triggeredBy]}
                                </p>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3.5 text-end tabular-nums text-muted-foreground">
                                {run.bytesTransferred == null
                                  ? "—"
                                  : formatBytes(run.bytesTransferred)}
                              </td>
                              <td className="px-5 py-3.5">
                                <div className="flex items-center justify-end gap-1">
                                  {succeeded && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setRestoreFromRun(run)}
                                      title={b.recent.restoreTitle}
                                    >
                                      <Icon name="rotate-left" className="size-3.5" />
                                      {b.recent.restore}
                                    </Button>
                                  )}
                                  {succeeded && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      disabled={busyIds.has(run.id)}
                                      title={
                                        protectedRun ? b.recent.allowPrune : b.recent.protectFrom
                                      }
                                      aria-label={
                                        protectedRun ? b.recent.allowPrune : b.recent.protectFrom
                                      }
                                      onClick={() => {
                                        void perform(
                                          run.id,
                                          async () => {
                                            await backupsApi.protectRun(run.id, {
                                              protected: !protectedRun,
                                            });
                                            await reload();
                                          },
                                          b.toast.toggleProtectionFailed,
                                        );
                                      }}
                                    >
                                      <Icon
                                        name={protectedRun ? "unlock" : "lock"}
                                        className="size-3.5"
                                      />
                                    </Button>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => {
                                      setActiveRunIds((previous) => [
                                        ...new Set([...previous, run.id]),
                                      ]);
                                      setDismissedRunIds((previous) => {
                                        const next = new Set(previous);
                                        next.delete(run.id);
                                        return next;
                                      });
                                      requestAnimationFrame(() => {
                                        activityRef.current?.scrollIntoView?.({ block: "nearest" });
                                      });
                                    }}
                                    title={b.recent.viewDetails}
                                    aria-label={`${b.recent.viewDetails}: ${scopeName(run.serviceId)}`}
                                  >
                                    <Icon name="activity" className="size-3.5" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {(current.hasMore || historyError) && (
                  <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                    {historyError && (
                      <p role="alert" className="text-sm text-danger">
                        {historyError}
                      </p>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={loadingMore || refreshing}
                      onClick={() => void loadOlder()}
                    >
                      {loadingMore && <Icon name="spinner" className="size-3.5 animate-spin" />}
                      {loadingMore ? b.recent.loading : b.recent.loadOlder}
                    </Button>
                  </div>
                )}
              </section>
              {trackedRunIds.length > 0 && (
                <section
                  ref={activityRef}
                  className="space-y-3"
                  aria-label={b.live.title}
                  hidden={liveRunIds.length === 0}
                >
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-foreground">{b.live.title}</h3>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDismissedRunIds((previous) => new Set([...previous, ...liveRunIds]));
                      }}
                    >
                      {b.live.dismiss}
                    </Button>
                  </div>
                  {trackedRunIds.map((runId) => {
                    const run = runsById.get(runId);
                    return (
                      <BackupRunCard
                        key={runId}
                        runId={runId}
                        initial={run}
                        visible={!dismissedRunIds.has(runId)}
                        serviceName={run ? scopeName(run.serviceId) : undefined}
                        onUpdate={updateRun}
                      />
                    );
                  })}
                </section>
              )}
            </div>
            <aside
              className="min-w-0 rounded-2xl border border-border/50 bg-card"
              aria-label={b.destinations.title}
            >
              <SectionHeading
                title={b.destinations.title}
                description={b.destinations.description}
              />
              {destinations.length === 0 ? (
                <div className="px-5 pt-5">
                  <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
                    <Icon name="hard-drive" className="size-5" />
                  </div>
                  <p className="text-sm font-medium text-foreground">{m.emptyTitle}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {b.destinations.emptyHint}
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-border/40">
                  {destinations.map((destination) => {
                    const editable = EDITABLE_KINDS.has(destination.kind);
                    const busy = busyIds.has(destination.id);
                    const used = policies.some((policy) => policy.destinationId === destination.id);
                    const actions: MenuAction[] = [];
                    if (editable)
                      actions.push({
                        id: "edit",
                        label: m.editAction,
                        icon: <Icon name="edit" className="size-4" />,
                        onClick: () => setDestinationEditor({ destination }),
                      });
                    actions.push({
                      id: "verify",
                      label: m.verifyConnection,
                      icon: <Icon name="refresh" className="size-4" />,
                      onClick: () => {
                        void perform(
                          destination.id,
                          async () => {
                            const result = await backupDestinationsApi.preflight(destination.id);
                            if (activeProject.current !== projectId) return;
                            if (!result.data.ok)
                              setActionError(result.data.reason ?? m.verificationFailedMsg);
                            await reload();
                          },
                          m.verificationFailedTitle,
                        );
                      },
                    });
                    if (!destination.isDefault)
                      actions.push({
                        id: "default",
                        label: m.setDefaultAction,
                        icon: <Icon name="star" className="size-4" />,
                        onClick: () => {
                          void perform(
                            destination.id,
                            async () => {
                              const result = await backupDestinationsApi.update(destination.id, {
                                isDefault: true,
                              });
                              saveDestination(result.data);
                            },
                            m.setDefaultFailed,
                          );
                        },
                      });
                    return (
                      <li key={destination.id} className="px-5 py-4">
                        <div className="flex items-start gap-2.5">
                          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground">
                            <Icon name={KIND_ICONS[destination.kind]} className="size-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            {editable ? (
                              <button
                                type="button"
                                onClick={() => setDestinationEditor({ destination })}
                                disabled={busy}
                                className="block max-w-full truncate text-start text-sm font-medium text-foreground hover:underline disabled:opacity-50"
                                title={interpolate(m.modalEditTitle, { name: destination.name })}
                              >
                                {destination.name}
                              </button>
                            ) : (
                              <p className="truncate text-sm font-medium text-foreground">
                                {destination.name}
                              </p>
                            )}
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {kindLabel(destination.kind, m)}
                            </p>
                          </div>
                          <DropdownMenu
                            actions={actions}
                            disabled={busy}
                            triggerLabel={`${b.destinations.manage}: ${destination.name}`}
                            trigger={
                              busy ? (
                                <Icon name="spinner" className="size-4 animate-spin" />
                              ) : undefined
                            }
                          />
                        </div>
                        <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]">
                          <DestinationVerificationBadge destination={destination} badge={false} />
                          {used && (
                            <span className="text-muted-foreground">{b.destinations.inUse}</span>
                          )}
                          {destination.isDefault && (
                            <span className="inline-flex items-center gap-1 text-muted-foreground">
                              <Icon name="star" className="size-3" />
                              {m.defaultBadge}
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="p-5">
                <Button
                  variant={destinations.length ? "outline" : "default"}
                  className="w-full"
                  onClick={() => setDestinationEditor({ destination: null })}
                >
                  <Icon name="plus" className="size-4" />
                  {m.addDestination}
                </Button>
              </div>
            </aside>
          </div>
          <section
            className="rounded-2xl border border-border/50 bg-card"
            aria-label={b.services.title}
          >
            <SectionHeading title={b.services.title} description={b.services.description} />
            <div className="divide-y divide-border/40">
              {scopes.flatMap((scope) => {
                const scopedPolicies = policiesByService.get(scope.serviceId) ?? [];
                return (scopedPolicies.length ? scopedPolicies : [null]).map((policy) => (
                  <PolicyRow
                    key={policy?.id ?? scope.serviceId ?? "project"}
                    scope={scope}
                    policy={policy}
                    destination={destinations.find(
                      (destination) => destination.id === policy?.destinationId,
                    )}
                    projectPolicyEnabled={projectPolicyEnabled}
                    busy={
                      !!policy &&
                      (busyIds.has(policy.id) ||
                        runs.some((run) => run.policyId === policy.id && isBackupRunning(run)))
                    }
                    onEdit={() => setEditingPolicy({ ...scope, existing: policy })}
                    onRun={() => {
                      if (policy) void runNow(policy);
                    }}
                  />
                ));
              })}
            </div>
          </section>
        </>
      )}
      {destinationEditor && (
        <CreateDestinationModal
          isOpen
          destination={destinationEditor.destination}
          onClose={() => setDestinationEditor(null)}
          onSaved={(destination) => {
            saveDestination(destination);
            setDestinationEditor(null);
          }}
        />
      )}
      {editingPolicy && (
        <PolicyEditor
          projectId={projectId}
          serviceId={editingPolicy.serviceId}
          serviceName={editingPolicy.serviceId ? editingPolicy.serviceName : undefined}
          serviceImage={editingPolicy.serviceImage}
          existing={editingPolicy.existing}
          initialDestination={
            preferredDestination ?? destinations.find((destination) => destination.isDefault)
          }
          onDestinationSaved={saveDestination}
          onClose={() => setEditingPolicy(null)}
          onSaved={(policy) => finishPolicy(policy)}
          onSavedAndRun={
            editingPolicy.existing ? undefined : (policy) => finishPolicy(policy, true)
          }
        />
      )}
      {restoreFromRun && (
        <RestoreWizard
          sourceRun={restoreFromRun}
          serviceName={restoreFromRun.serviceId ? scopeName(restoreFromRun.serviceId) : undefined}
          onClose={() => {
            setRestoreFromRun(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="border-b border-border/40 px-5 py-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}
function Summary({
  icon,
  label,
  value,
  className = "",
}: {
  icon: IconName;
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={`min-w-0 border-border/50 px-5 py-4 ${className}`}>
      <dt className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon name={icon} className="size-3.5" />
        {label}
      </dt>
      <dd className="mt-2 text-sm font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
function PolicyRow({
  scope,
  policy,
  destination,
  projectPolicyEnabled,
  busy,
  onEdit,
  onRun,
}: {
  scope: PolicyScope;
  policy: BackupPolicy | null;
  destination?: BackupDestinationSummary;
  projectPolicyEnabled: boolean;
  busy: boolean;
  onEdit: () => void;
  onRun: () => void;
}) {
  const { t, locale } = useI18n();
  const b = t.projectSettings.backup;
  const w = t.widgets.backup.policyEditor;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
          <Icon name={scope.serviceId ? "server" : "layers"} className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium text-foreground">{scope.serviceName}</p>
            {policy && !policy.enabled && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {b.overview.paused}
              </span>
            )}
          </div>
          {policy ? (
            <>
              <p
                className="mt-1 truncate text-xs text-muted-foreground"
                title={
                  policy.cronExpression
                    ? `${policy.cronExpression} · ${b.schedule.timezone}`
                    : undefined
                }
              >
                {destination?.name ?? w.destination}
                <span className="mx-1.5 text-muted-foreground/40">·</span>
                {scheduleLabel(policy.cronExpression, b, w, locale)}
              </p>
              <p className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground/80">
                {policy.retainCount != null && (
                  <span>
                    {interpolate(b.services.retainCount, { count: String(policy.retainCount) })}
                  </span>
                )}
                {policy.retainDays != null && (
                  <span>
                    {interpolate(b.services.retainDays, { days: String(policy.retainDays) })}
                  </span>
                )}
                {policy.triggerOnPreDeploy && <span>{b.services.preDeploy}</span>}
                {policy.webhookToken && <span>{b.services.webhook}</span>}
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {scope.serviceId
                ? projectPolicyEnabled
                  ? b.services.includedInProject
                  : b.services.noPolicy
                : b.services.projectHint}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1">
        {policy ? (
          <>
            <Button variant="outline" size="sm" disabled={busy} onClick={onRun}>
              <Icon
                name={busy ? "spinner" : "play-circle"}
                className={`size-3.5 ${busy ? "animate-spin" : ""}`}
              />
              {b.services.backupNow}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onEdit}
              disabled={busy}
              title={b.services.editPolicy}
              aria-label={`${b.services.editPolicy}: ${scope.serviceName}`}
            >
              <Icon name="settings" className="size-4" />
            </Button>
          </>
        ) : (
          <Button variant={scope.serviceId ? "outline" : "default"} size="sm" onClick={onEdit}>
            <Icon name="plus" className="size-3.5" />
            {b.services.createPolicy}
          </Button>
        )}
      </div>
    </div>
  );
}
function scheduleLabel(
  cron: string | null,
  b: BackupCopy,
  w: ReturnType<typeof useI18n>["t"]["widgets"]["backup"]["policyEditor"],
  locale: string,
) {
  if (!cron) return w.summaryScheduleManual;
  if (cron === "0 * * * *") return w.presetHourly;
  const parts = partsFromCron(cron);
  if (parts.frequency === "daily") return interpolate(b.schedule.daily, { time: parts.time });
  if (parts.frequency === "weekly")
    return interpolate(b.schedule.weekly, {
      day: new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
        new Date(Date.UTC(2026, 0, 4 + parts.weekday)),
      ),
      time: parts.time,
    });
  if (parts.frequency === "monthly")
    return interpolate(b.schedule.monthly, { day: String(parts.dayOfMonth), time: parts.time });
  return b.schedule.custom;
}
function formatDate(value: string, locale: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
