import React, { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  Check,
  ChevronDown,
  Cloud,
  Copy,
  HardDrive,
  Hammer,
  Loader2,
  MoreVertical,
  Network,
  Package,
  Pause,
  Pencil,
  Play,
  Server,
  Settings2,
  ShieldCheck,
  Trash2,
  Waypoints,
  Zap,
} from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { DeletionModal } from "./DeletionModal";
import { ProjectRenameModal } from "./ProjectRenameModal";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { projectsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";
import { migrationNeedsOperator } from "@/utils/project-status";
import type { RouteStrategy } from "@/lib/api/settings";
import type { OpenshipReadiness } from "@repo/core";
import { workloadOf } from "@/context/deployment/types";
import ReadinessSection from "@/components/project-settings/ReadinessSection";
import { ProjectMigrationCard } from "@/components/migration/ProjectMigrationCard";
import { ProjectMigrationHistory } from "@/components/migration/ProjectMigrationHistory";
import { ServerMigrationWizard } from "@/components/migration/ServerMigrationWizard";

interface Props {
  onDeleteProject: (wipeVolumes?: boolean, recordOnly?: boolean) => void;
}

const ICON_TONES = {
  primary: "bg-primary/10 text-primary",
  amber: "bg-warning-bg text-warning",
  red: "bg-danger-bg text-danger",
} as const;

// Cache and Transfer & Clone are mock UI — not wired to real actions yet.
// Flip to true to reveal them once the backend is ready.
const SHOW_MOCK_ADVANCED = false;

function SectionCard({
  title,
  description,
  icon: Icon,
  iconTone,
  children,
  collapsible = false,
  defaultOpen = false,
  allowOverflow = false,
}: {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  iconTone: keyof typeof ICON_TONES;
  children: React.ReactNode;
  /** Render collapsed behind an expand toggle (header stays visible), matching
   *  the collapsible settings sections. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  /**
   * Drop the corner clip, for a card whose content opens something that has to ESCAPE it —
   * a dropdown, a popover, a menu. `overflow-hidden` is what keeps ordinary children inside
   * the 2xl radius, but it also cuts an absolutely-positioned menu off at the card's edge,
   * so a server picker near the bottom of a card renders half a list.
   *
   * The Project Info card above has always omitted the class for exactly this reason (its
   * ⋮ menu), and there is a test pinning that. This makes the same escape hatch available
   * to the cards that go through here instead of forcing them to be hand-rolled.
   */
  allowOverflow?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expanded = collapsible ? open : true;

  const header = (
    <>
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${ICON_TONES[iconTone]}`}>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>
      </div>
      {collapsible && (
        <ChevronDown
          className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      )}
    </>
  );

  return (
    <div
      className={`flex h-full flex-col rounded-2xl border border-border/50 bg-card ${
        allowOverflow ? "" : "overflow-hidden"
      }`}
    >
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={`flex w-full items-start gap-3 px-5 py-4 text-start ${expanded ? "border-b border-border/40" : ""}`}
        >
          {header}
        </button>
      ) : (
        <div className="flex items-start gap-3 border-b border-border/40 px-5 py-4">{header}</div>
      )}
      {expanded && <div className="flex-1 space-y-4 px-5 py-4">{children}</div>}
    </div>
  );
}

export const AdvancedSettings = ({ onDeleteProject }: Props) => {
  const { showToast } = useToast();
  const { t } = useI18n();
  const { projectData } = useProjectSettings();
  // `enabled` is the server's answer (derived from disabled_at in enrichProject).
  // This local copy exists only so the button flips the instant the call returns;
  // the effect below re-seeds it from the payload, so a refresh — or a toggle that
  // failed on the host — always converges on what the API says. Reading a field
  // the API never sent (`active`) is what made a disabled project render "Active".
  const [isProjectActive, setIsProjectActive] = useState(projectData?.enabled ?? true);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);

  useEffect(() => {
    if (typeof projectData?.enabled === "boolean") setIsProjectActive(projectData.enabled);
  }, [projectData?.enabled]);

  const projectId = projectData?.id ? String(projectData.id) : "";

  /**
   * The live migration — read from the PROJECT, not fetched from the migration API.
   *
   * `activeMigration` is part of the project payload (API `readActiveMigration`), which is the
   * same field the status pill on every card, the sidebar and the page header now read. So a
   * run is not something this tab discovers by asking on mount: it is part of what the project
   * IS, and every surface learns it from the payload it already loads. The tab-local fetch this
   * replaced knew about a run only while mounted — a reload restarted that clock, and no other
   * surface knew anything at all.
   */
  const activeRun = projectData?.activeMigration ?? null;
  // Parked (awaiting cutover / partial) vs advancing. Asked through the shared predicate so
  // this panel and the status pills can't disagree about which phases mean "your move".
  const runNeedsOperator = migrationNeedsOperator(activeRun);

  // The run whose SESSION this tab is showing, and the two things that can override the
  // payload — in both directions.
  //
  // `startedRunId` opens the session the instant a run starts, without waiting for the payload
  // refetch that will also report it, and keeps it open once the run goes terminal: having just
  // confirmed a move, you should land on its result, not be dropped back into settings.
  //
  // `dismissedRunId` is the other direction: Back means "let me at the settings", and without
  // it the payload would immediately reopen the session it just closed. By run ID, not a
  // boolean, so dismissing one run does not suppress the next.
  const [startedRunId, setStartedRunId] = useState<string | null>(null);
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
  const openRunId = startedRunId ?? activeRun?.id ?? null;
  const sessionRunId = openRunId && openRunId !== dismissedRunId ? openRunId : null;

  const leaveSession = useCallback(() => {
    setDismissedRunId(openRunId);
    setStartedRunId(null);
    // The run may have finished (or been cut over / rolled back) while the panel was open, and
    // the payload is what every surface reads for that. Re-read it on the way out.
    if (projectId) invalidateProjectCaches(projectId);
  }, [openRunId, projectId]);

  const [loading, setLoading] = useState({
    disableProject: false,
    clearInstallCache: false,
    clearBuildCache: false,
  });

  /**
   * Run one of this panel's async actions: hold the button, always release it,
   * and report a failure with the API's own reason.
   *
   * All three actions used to hand-roll this and all three got it wrong the same
   * way — they read `response.success` on a client that THROWS for any non-2xx
   * (see `api.post`). So the failure branch was unreachable, the throw escaped
   * the handler, and `setLoading(false)` never ran: the button sat spinning
   * forever with no message. One runner means a fourth action can't repeat it.
   */
  const runAction = async (
    key: keyof typeof loading,
    action: () => Promise<unknown>,
    failTitle: string,
  ) => {
    if (loading[key]) return false;
    setLoading((s) => ({ ...s, [key]: true }));
    try {
      await action();
      return true;
    } catch (err) {
      showToast(getApiErrorMessage(err, failTitle), "error", failTitle);
      return false;
    } finally {
      setLoading((s) => ({ ...s, [key]: false }));
    }
  };

  const handleDisableProject = async () => {
    const next = !isProjectActive;
    const ok = await runAction(
      "disableProject",
      () => projectsApi.toggle(projectData.id, next),
      t.projectSettings.advanced.toast.toggleFailed,
    );
    if (!ok) return;
    setIsProjectActive(next);
    // The action stops/starts containers, so the whole project payload (status
    // pill, access URL, health) is stale — invalidate rather than patch one field,
    // and the provider re-seeds every consumer from the server.
    invalidateProjectCaches(String(projectData.id));
  };

  const handleClearInstallCache = () =>
    runAction(
      "clearInstallCache",
      () => projectsApi.clearCache(projectData.id),
      t.projectSettings.advanced.toast.clearInstallFailed,
    );

  const handleClearBuildCache = () =>
    runAction(
      "clearBuildCache",
      () => projectsApi.clearBuild(projectData.id),
      t.projectSettings.advanced.toast.clearBuildFailed,
    );

  const menu = t.projectSettings.advanced.projectMenu;

  const handleCopyProjectId = async () => {
    const id = String(projectData?.id ?? "");
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      showToast(id, "success", menu.idCopied);
    } catch {
      // Insecure context or a denied clipboard permission — say so rather than
      // reporting a copy that never happened.
      showToast(menu.copyFailed, "error", menu.copyId);
    }
  };

  /**
   * Project-level actions for the Project Info header. Only Rename is new; the rest
   * drive the controls this panel already owns (the pause toggle below, the deletion
   * modal at the bottom) so there's one implementation of each, reachable from the
   * heading as well as from its own section.
   */
  const menuActions: MenuAction[] = [
    {
      id: "rename",
      label: menu.rename,
      icon: <Pencil className="size-4" />,
      onClick: () => setShowRenameModal(true),
    },
    {
      id: "copy-id",
      label: menu.copyId,
      icon: <Copy className="size-4" />,
      onClick: () => void handleCopyProjectId(),
      divider: true,
    },
    {
      id: "toggle",
      label: isProjectActive ? menu.pause : menu.resume,
      icon: isProjectActive ? <Pause className="size-4" /> : <Play className="size-4" />,
      onClick: () => void handleDisableProject(),
      disabled: loading.disableProject,
      variant: isProjectActive ? "warning" : "success",
      divider: true,
    },
    {
      id: "delete",
      label: menu.delete,
      icon: <Trash2 className="size-4" />,
      onClick: () => setShowDeleteModal(true),
      variant: "danger",
    },
  ];

  // A started move takes over the whole tab: the run panel is a full flow (phases, logs,
  // cutover confirmation, rollback), not something to nest inside a third-width card. The
  // panel below is the SAME component the server's Migrations tab opens a row into, reached
  // by run id — so there is no second progress implementation to keep in step.
  if (sessionRunId) {
    return (
      <ServerMigrationWizard
        variant="tab"
        // A PROJECT entry point: the workload is this project's own containers, so the panel
        // must never fall through to the server scan/select flow — which is what a failed
        // run's retry used to do, offering to adopt containers from the whole box.
        origin="project"
        serverId={projectData?.serverId ?? undefined}
        initialRunId={sessionRunId}
        onClose={leaveSession}
        onBack={leaveSession}
      />
    );
  }

  const canMoveProject =
    projectData?.deployTarget === "server" && Boolean(projectData?.serverId) && !projectData?.isApp;

  return (
    <div className="space-y-5">
      {/* Top row — Info · Status, two up. Three across was the mistake: each card then got
          a third of the width, which is narrower than their own content wants, and the
          Migration card needs the most room of the three (a picker, a mode switch and a
          button). It moved below as a collapsed row instead. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      {/* Project Info — no `overflow-hidden` (unlike the SectionCards below): the
          header's ⋮ opens an absolutely-positioned menu, which a clipping ancestor
          would cut off. Nothing here needs the clip — the header's rule sits well
          below the corner radius. */}
      <div className="flex h-full flex-col rounded-2xl border border-border/50 bg-card">
        <div className="flex items-start gap-3 rounded-t-2xl border-b border-border/40 px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Settings2 className="size-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold text-foreground">{t.projectSettings.advanced.projectInfo.title}</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{t.projectSettings.advanced.projectInfo.description}</p>
          </div>
          {/* Project-level actions live on the heading, where the name is shown. */}
          <DropdownMenu
            actions={menuActions}
            trigger={<MoreVertical className="size-4 text-muted-foreground" />}
            triggerClassName="-me-1.5 shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            className="shrink-0"
          />
        </div>
        {/* STACKED, not a horizontal row. `MetricRow` is a full-width label↔value pair
            (`justify-between`), so three of them side by side each tried to span the card
            and collided — and since this card has no `overflow-hidden` (the ⋮ menu needs
            to escape it), the collision spilled into the neighbouring card. */}
        <div className="space-y-2.5 px-5 py-4">
          <MetricRow label={t.projectSettings.advanced.metric.status} value={isProjectActive ? t.projectSettings.advanced.statusActive : t.projectSettings.advanced.statusDisabled} />
          <MetricRow
            label={t.projectSettings.advanced.metric.project}
            value={projectData?.name || "-"}
            action={
              <button
                type="button"
                onClick={() => setShowRenameModal(true)}
                aria-label={menu.rename}
                title={menu.rename}
                className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Pencil className="size-3" />
              </button>
            }
          />
          {projectData?.deployTarget && (
            <MetricRow
              label={t.projectSettings.advanced.metric.hostedOn}
              value={
                projectData.deployTarget === "cloud"
                  ? t.projectSettings.advanced.hostedCloud
                  : projectData.deployTarget === "server"
                    ? projectData.serverName || t.projectSettings.advanced.hostedServer
                    : t.projectSettings.advanced.hostedLocal
              }
            />
          )}
        </div>
      </div>

      {/* Project Status */}
      <SectionCard
        title={t.projectSettings.advanced.projectStatus.title}
        description={t.projectSettings.advanced.projectStatus.description}
        icon={Settings2}
        iconTone="primary"
      >
          {/* Wraps rather than squeezing: in a third-width card the label pair and the
              button can't share a line, and `justify-between` with no wrap is what forced
              "Live and accessible" onto three lines beside a crushed button. */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                  activeRun ? "bg-warning-bg" : isProjectActive ? "bg-success-bg" : "bg-warning-bg"
                }`}
              >
                {activeRun ? (
                  <ArrowRightLeft className="size-4 animate-pulse text-warning" />
                ) : isProjectActive ? (
                  <Pause className="size-4 text-success" />
                ) : (
                  <Play className="size-4 text-warning" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground">
                  {activeRun
                    ? t.projectSettings.advanced.projectStatus.migrating
                    : isProjectActive
                      ? t.projectSettings.advanced.projectStatus.active
                      : t.projectSettings.advanced.projectStatus.disabled}
                </p>
                <p className="text-[12px] leading-snug text-muted-foreground">
                  {/* A migrating project is neither "live and accessible" nor "paused": its
                      containers are being quiesced and streamed to another host, so saying
                      either would be wrong. */}
                  {activeRun
                    ? t.projectSettings.advanced.projectStatus.migratingHint
                    : isProjectActive
                      ? t.projectSettings.advanced.projectStatus.liveAccessible
                      : t.projectSettings.advanced.projectStatus.pausedInaccessible}
                </p>
              </div>
            </div>
            <button
              onClick={handleDisableProject}
              // Disabled during a migration: pause stops containers, which is exactly what the
              // run is orchestrating — the two would fight over the same containers.
              disabled={loading.disableProject || Boolean(activeRun)}
              className={`inline-flex h-9 items-center gap-1.5 rounded-xl px-4 text-[13px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                isProjectActive
                  ? "bg-warning-bg text-warning hover:bg-warning-solid/20"
                  : "bg-primary/10 text-primary hover:bg-primary/20"
              }`}
            >
              {loading.disableProject ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : isProjectActive ? (
                t.projectSettings.advanced.projectStatus.disable
              ) : (
                t.projectSettings.advanced.projectStatus.enable
              )}
            </button>
          </div>
        </SectionCard>

      </div>

        {/* Migration — a COLLAPSED full-width row, like Routing and Health checks below.
            Collapsed because you migrate a project rarely and read this tab often, and
            full-width because expanded it needs to lay a server picker, a move/duplicate
            switch and a service scope out side by side without wrapping. Self-hosted,
            server-bound projects only: Cloud (either direction) is later work, and a
            catalog app has no source host to move from. */}
        {canMoveProject && projectData && (
          <SectionCard
            title={t.projectSettings.advanced.migration.title}
            // A live run takes over the description: collapsed-and-silent is right when
            // nothing is happening and wrong when something is, and this row is the only
            // place on the tab that can say so.
            description={
              runNeedsOperator
                ? // NOT "In progress — Awaiting cutover", which is what phrasing every live run
                  // the same way produced: a parked run is the opposite of in progress. Same
                  // sentence the status pill's own hint uses, so the row and the pill agree.
                  t.projects.migrationAwaitingHint
                : activeRun
                  ? interpolate(t.projectSettings.advanced.migration.runningStatus, {
                      status:
                        t.migration.tab.status[
                          activeRun.status as keyof typeof t.migration.tab.status
                        ] ?? activeRun.status,
                    })
                  : t.projectSettings.advanced.migration.description
            }
            icon={ArrowRightLeft}
            // Amber only when the run has STOPPED and wants something: an advancing transfer
            // needs nothing from the operator, and amber that means "in progress" here would
            // clash with amber meaning "act now" everywhere else in the app.
            iconTone={runNeedsOperator ? "amber" : "primary"}
            collapsible
            // Open on arrival when a run is in flight — a migration in progress is not
            // something to hide behind a chevron.
            defaultOpen={Boolean(activeRun)}
            // The server picker's menu opens downward from near the card's lower edge, so a
            // clipped card shows a truncated list you can't select from.
            allowOverflow
          >
            <ProjectMigrationCard
              projectId={projectData.id}
              projectName={projectData.name}
              sourceServerId={projectData.serverId as string}
              sourceServerName={projectData.serverName}
              onStarted={(runId) => {
                setDismissedRunId(null);
                setStartedRunId(runId);
                // Every OTHER surface reads the run off the project payload, so the pill on
                // the cards list and in the page header only says "Migrating" once that
                // payload is re-read. This is the one moment the client knows a run began
                // before the server has been asked again.
                if (projectId) invalidateProjectCaches(projectId);
              }}
            />
            {/* Past migrations of THIS project, including a duplicate taken from it. Same rows
                the server's Migrations tab shows, and clicking one reopens its session through
                the same state a fresh run uses — so a parked run is reachable from the project
                it belongs to, not only from whichever server it happened to touch. Renders
                nothing until there is history. */}
            <ProjectMigrationHistory
              projectId={projectData.id}
              onOpenRun={(runId) => {
                setDismissedRunId(null);
                setStartedRunId(runId);
              }}
            />
          </SectionCard>
        )}

        {/* Routing (edge → app upstream) — self-hosted only; cloud handles its
            own ingress. Advanced opt-in; loopback-port is the safe default. */}
        {projectData?.deployTarget !== "cloud" && (
          <SectionCard
            title={t.projectSettings.advanced.routing.title}
            description={t.projectSettings.advanced.routing.description}
            icon={Waypoints}
            iconTone="primary"
            collapsible
          >
            <RoutingStrategyCard
              projectId={projectData.id}
              initial={(projectData?.routeStrategy as RouteStrategy) ?? "auto"}
            />
          </SectionCard>
        )}

        {/* Internal hostname (east-west alias) — single-app, self-hosted, with a
            running container only. Compose projects set this per service in the
            service form; static/cloud apps have no private container to name. */}
        {projectData?.deployTarget !== "cloud" &&
          (projectData?.serviceCount ?? 0) === 0 &&
          workloadOf({
            workloadType: projectData?.workloadType ?? projectData?.options?.workloadType,
            hasServer: projectData?.hasServer ?? projectData?.options?.hasServer,
          }) !== "static" && (
            <SectionCard
              title={t.projectSettings.advanced.internalAlias.title}
              description={t.projectSettings.advanced.internalAlias.description}
              icon={Network}
              iconTone="primary"
              collapsible
            >
              <InternalAliasCard
                projectId={projectData.id}
                initial={(projectData?.internalAlias as string | null) ?? ""}
                slug={(projectData?.slug as string | undefined) ?? ""}
              />
            </SectionCard>
          )}

        {/* Health checks — collapsed, and off unless opted into. Reuses the
            wizard's section so the form and its copy exist once. */}
        <SectionCard
          title={t.importProject.buildSettings.healthCheck.title}
          description={t.importProject.buildSettings.healthCheck.subtitle}
          icon={Activity}
          iconTone="primary"
          collapsible
        >
          <ReadinessCard
            projectId={projectData.id}
            initial={(projectData?.readiness as OpenshipReadiness | null) ?? null}
          />
        </SectionCard>

        {/* Cache Management (mock — hidden until wired) */}
        {SHOW_MOCK_ADVANCED && (
        <SectionCard
          title={t.projectSettings.advanced.cache.title}
          description={t.projectSettings.advanced.cache.description}
          icon={Package}
          iconTone="amber"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              onClick={handleClearInstallCache}
              disabled={loading.clearInstallCache}
              className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-start transition-colors hover:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <Package className="size-4 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground">{t.projectSettings.advanced.cache.clearInstall}</p>
                <p className="text-[12px] text-muted-foreground">{t.projectSettings.advanced.cache.clearInstallDesc}</p>
              </div>
              {loading.clearInstallCache && <Loader2 className="ms-auto size-4 animate-spin text-muted-foreground" />}
            </button>

            <button
              onClick={handleClearBuildCache}
              disabled={loading.clearBuildCache}
              className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-start transition-colors hover:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <Hammer className="size-4 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground">{t.projectSettings.advanced.cache.clearBuild}</p>
                <p className="text-[12px] text-muted-foreground">{t.projectSettings.advanced.cache.clearBuildDesc}</p>
              </div>
              {loading.clearBuildCache && <Loader2 className="ms-auto size-4 animate-spin text-muted-foreground" />}
            </button>
          </div>
        </SectionCard>
        )}

        {/* Transfer & Clone (mock — hidden until wired) */}
        {SHOW_MOCK_ADVANCED && (
        <SectionCard
          title={t.projectSettings.advanced.transfer.title}
          description={t.projectSettings.advanced.transfer.description}
          icon={ArrowRightLeft}
          iconTone="primary"
        >
          <TransferOptions
            currentTarget={projectData?.deployTarget}
            currentServer={projectData?.serverName}
          />
        </SectionCard>
        )}

        {/* Danger Zone */}
        <div className="overflow-hidden rounded-2xl border border-danger-border bg-card">
          <div className="flex items-start gap-3 border-b border-danger-border px-5 py-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-danger-bg">
              <AlertTriangle className="size-4 text-danger" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-[14px] font-semibold text-danger">{t.projectSettings.advanced.danger.title}</h3>
              <p className="mt-0.5 text-[12px] text-muted-foreground">{t.projectSettings.advanced.danger.description}</p>
            </div>
          </div>
          <div className="px-5 py-4">
            <p className="text-[13px] text-muted-foreground leading-relaxed">
              {t.projectSettings.advanced.danger.body}
            </p>
            <button
              onClick={() => setShowDeleteModal(true)}
              className="mt-4 inline-flex h-9 items-center gap-2 rounded-xl bg-danger-solid px-4 text-[13px] font-medium text-white transition-colors hover:bg-danger-solid/90"
            >
              <Trash2 className="size-3.5" />
              {t.projectSettings.advanced.danger.delete}
            </button>
          </div>
        </div>

      <ProjectRenameModal
        isOpen={showRenameModal}
        onClose={() => setShowRenameModal(false)}
      />

      <DeletionModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={onDeleteProject}
        projectName={projectData?.name || projectData?.domain}
        projectId={projectData?.id}
        selfHosted={projectData?.deployTarget !== "cloud"}
      />
    </div>
  );
};

/* ── Routing strategy (edge → app upstream) ───────────────────────── */

const ROUTE_MODES: {
  value: RouteStrategy;
  key: "auto" | "loopbackPort" | "containerIp";
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: "auto", key: "auto", icon: Zap },
  { value: "loopback-port", key: "loopbackPort", icon: ShieldCheck },
  { value: "container-ip", key: "containerIp", icon: Network },
];

function RoutingStrategyCard({
  projectId,
  initial,
}: {
  projectId: string;
  initial: RouteStrategy;
}) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [strategy, setStrategy] = useState<RouteStrategy>(initial);
  const [saving, setSaving] = useState(false);

  async function handleChange(mode: RouteStrategy) {
    if (mode === strategy || saving) return;
    const prev = strategy;
    setStrategy(mode);
    setSaving(true);
    try {
      const res = await projectsApi.update(projectId, { routeStrategy: mode });
      if ((res as { success?: boolean })?.success === false) throw new Error("update failed");
      const label = t.projectSettings.advanced.routing.modes[ROUTE_MODES.find((m) => m.value === mode)!.key].label;
      showToast(
        interpolate(t.projectSettings.advanced.routing.toast.saved, { mode: label }),
        "success",
        t.projectSettings.advanced.routing.title,
      );
    } catch {
      setStrategy(prev);
      showToast(
        t.projectSettings.advanced.routing.toast.failed,
        "error",
        t.projectSettings.advanced.routing.title,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <p className="text-[12px] text-muted-foreground">{t.projectSettings.advanced.routing.intro}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        {ROUTE_MODES.map(({ value, key, icon: ModeIcon }) => {
          const active = strategy === value;
          return (
            <button
              key={value}
              onClick={() => handleChange(value)}
              disabled={saving}
              className={`relative text-start rounded-xl border p-4 transition-all ${
                active
                  ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20"
                  : "border-border/50 bg-card hover:bg-muted/40 hover:border-border"
              } disabled:opacity-50`}
            >
              <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
                <ModeIcon className="size-4 text-muted-foreground" />
              </div>
              <p className="text-[13px] font-medium text-foreground">
                {t.projectSettings.advanced.routing.modes[key].label}
              </p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {t.projectSettings.advanced.routing.modes[key].desc}
              </p>
              {active && (
                <div className="absolute top-3 end-3">
                  <Check className="size-4 text-primary" />
                </div>
              )}
            </button>
          );
        })}
      </div>
      <p className="text-[12px] text-muted-foreground">{t.projectSettings.advanced.routing.note}</p>
    </>
  );
}

/**
 * Single-app custom east-west hostname. Persists `project.internalAlias`, which
 * the deploy adds as an EXTRA docker alias alongside the default `<slug>` (both
 * resolve). Explicit Save (free-text) with optimistic toast + rollback, matching
 * RoutingStrategyCard. Server normalizes + rejects an empty-after-normalize value;
 * we mirror the "needs a usable char" check client-side for a fast inline error.
 */
function InternalAliasCard({
  projectId,
  initial,
  slug,
}: {
  projectId: string;
  initial: string;
  slug: string;
}) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const c = t.projectSettings.advanced.internalAlias;
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [saving, setSaving] = useState(false);

  const trimmed = value.trim();
  const dirty = trimmed !== saved.trim();

  async function handleSave() {
    if (!dirty || saving) return;
    // Empty clears it (server falls back to the slug). A non-empty value must
    // carry at least one letter/digit or it normalizes to nothing.
    if (trimmed && !/[a-z0-9]/i.test(trimmed)) {
      showToast(c.toast.invalid, "error", c.title);
      return;
    }
    setSaving(true);
    try {
      const res = await projectsApi.update(projectId, { internalAlias: trimmed || null });
      if ((res as { success?: boolean })?.success === false) throw new Error("update failed");
      setSaved(trimmed);
      showToast(c.toast.saved, "success", c.title);
    } catch {
      showToast(c.toast.failed, "error", c.title);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <p className="text-[12px] text-muted-foreground">{c.intro}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex-1">
          <span className="mb-1 block text-[12px] font-medium text-foreground">{c.label}</span>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void handleSave(); }
            }}
            placeholder={slug || "app"}
            spellCheck={false}
            autoCapitalize="none"
            className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
          />
        </label>
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saving}
          className="h-11 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {c.save}
        </button>
      </div>
      <p className="text-[12px] text-muted-foreground">{c.hint}</p>
    </>
  );
}

function MetricRow({
  label,
  value,
  action,
}: {
  label: string;
  value: string;
  /** Optional trailing control (e.g. the name row's rename pencil). */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1">
        <span className="max-w-[180px] truncate text-end text-[13px] font-medium text-foreground">{value}</span>
        {action}
      </span>
    </div>
  );
}

/* ── Health checks ────────────────────────────────────────────────── */

/**
 * Persisting wrapper around the shared ReadinessSection.
 *
 * Debounced because the section has free-text/number inputs — RoutingStrategyCard
 * can PATCH per click since it's a 3-way pick, but a timeout field would otherwise
 * fire a request per keystroke. Optimistic with a rollback on failure, matching
 * RoutingStrategyCard.
 */
function ReadinessCard({
  projectId,
  initial,
}: {
  projectId: string;
  initial: OpenshipReadiness | null;
}) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [value, setValue] = useState<OpenshipReadiness | null>(initial);
  const savedRef = React.useRef<OpenshipReadiness | null>(initial);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const title = t.importProject.buildSettings.healthCheck.title;

  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  function handleChange(next: OpenshipReadiness | undefined) {
    const resolved = next ?? null;
    setValue(resolved);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      const previous = savedRef.current;
      try {
        const res = await projectsApi.update(projectId, { readiness: resolved });
        if ((res as { success?: boolean })?.success === false) throw new Error("update failed");
        savedRef.current = resolved;
      } catch {
        setValue(previous);
        showToast(t.projectSettings.advanced.routing.toast.failed, "error", title);
      }
    }, 700);
  }

  return <ReadinessSection value={value} onChange={handleChange} embedded />;
}

/* ── Transfer & Clone ─────────────────────────────────────────────── */

const TARGET_META: Record<string, { icon: React.ReactNode }> = {
  local: { icon: <HardDrive className="size-4" /> },
  server: { icon: <Server className="size-4" /> },
  cloud: { icon: <Cloud className="size-4" /> },
};

function TransferOptions({
  currentTarget,
  currentServer,
}: {
  currentTarget?: string | null;
  currentServer?: string | null;
}) {
  const { t } = useI18n();
  const targetLabels: Record<string, string> = {
    local: t.projectSettings.advanced.transfer.targetLocal,
    server: t.projectSettings.advanced.transfer.targetServer,
    cloud: t.projectSettings.advanced.transfer.targetCloud,
  };
  const current = TARGET_META[currentTarget ?? ""];

  // Build transfer options - everything except the current target
  const transferTargets = Object.entries(TARGET_META).filter(
    ([key]) => key !== currentTarget,
  );

  return (
    <div className="space-y-3">
      {/* Current location */}
      {current && (
        <div className="flex items-center gap-3 rounded-xl bg-muted px-4 py-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            {current.icon}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-foreground">{targetLabels[currentTarget ?? ""]}</p>
            {currentTarget === "server" && currentServer && (
              <p className="text-[12px] text-muted-foreground">{currentServer}</p>
            )}
          </div>
          <span className="inline-flex items-center gap-1 shrink-0 text-[12px] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-success-solid" />
            {t.projectSettings.advanced.transfer.current}
          </span>
        </div>
      )}

      {/* Transfer + Clone options */}
      <div className="grid gap-2 sm:grid-cols-3">
        {transferTargets.map(([key, meta]) => (
          <button
            key={key}
            className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-start transition-colors hover:border-border hover:bg-muted/40"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              {meta.icon}
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-foreground">{t.projectSettings.advanced.transfer.transfer}</p>
              <p className="text-[12px] text-muted-foreground">{targetLabels[key]}</p>
            </div>
          </button>
        ))}

        <button
          className="flex items-center gap-3 rounded-xl border border-dashed border-border/50 bg-muted/10 px-4 py-3 text-start transition-colors hover:border-border hover:bg-muted/30"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Copy className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground">{t.projectSettings.advanced.transfer.clone}</p>
            <p className="text-[12px] text-muted-foreground">{t.projectSettings.advanced.transfer.anotherServer}</p>
          </div>
        </button>
      </div>
    </div>
  );
}

