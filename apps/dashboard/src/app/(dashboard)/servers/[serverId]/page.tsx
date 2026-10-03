"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

import { use, useState, useEffect, useCallback, useRef } from "react";
import { BlurIp } from "@/components/BlurIp";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { ApiError, getApiErrorMessage, isAbortError, systemApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useModal } from "@/context/ModalContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { PageContainer } from "@/components/ui/PageContainer";
import { Tabs } from "@/components/ui/Tabs";
import { ResourceNotFound } from "@/components/resource-not-found";
import { useSetupStream } from "@/hooks/useSetupStream";
import { useMonitorStream } from "@/hooks/useMonitorStream";
import { useServerTunnels } from "@/hooks/useServerTunnels";
import type { ServerInfo, ComponentStatus, SetupComponentProgress, SetupLogEvent } from "@/lib/api/system";
import { PromptDetails } from "@/components/import-project/PromptDetails";
import { ServerForm } from "@/components/servers/server-form";
import { OverviewTab } from "./_components/overview-tab";
import { ComponentsTab } from "./_components/components-tab";
import { ServerModuleUpdates } from "./_components/module-updates";
import { ServerContainerUpdates } from "./_components/container-updates";
import { TerminalTab } from "./_components/terminal-tab";
import {
  ConnectionBanner,
  classifyConnectionError,
  readConnectionDiagnosis,
  type ConnectionDiagnosis,
  type ConnectionErrorKind,
} from "./_components/connection-banner";

import { RateLimitSettings } from "./_components/rate-limit-settings";
import { ExposedPortsCard } from "./_components/exposed-ports-card";
import { PortForwardingCard } from "./_components/port-forwarding-card";
import { ServerGitHubConnect } from "@/components/github/ServerGitHubConnect";
import { MigrationsTab } from "@/components/migration/MigrationsTab";
import { ServerConnectionCard } from "./_components/connection-card";
import { ServerDeletionModal } from "@/components/servers/ServerDeletionModal";
import { usePlatform } from "@/context/PlatformContext";
import { ServerInfrastructure } from "@/components/servers/ServerInfrastructure";
import { Button } from "@/components/ui/button";
import DropdownMenu from "@/components/ui/DropdownMenu";
import { ManagedServerPlan } from "@/components/servers/managed/ManagedServerPlan";
import { ManagedServerActivity } from "@/components/servers/managed/ManagedServerActivity";
import { ManagedServerActionFeedback } from "@/components/servers/managed/ManagedServerActionFeedback";
import { ManagedServerStatus } from "@/components/servers/managed/ManagedServerStatus";
import { useManagedServerActions } from "@/components/servers/managed/useManagedServerActions";
import { ServerUsage } from "@/components/servers/ServerUsage";
import { ManagedServerNetwork } from "@/components/servers/managed/ManagedServerNetwork";


type Tab = "overview" | "activity" | "migrations" | "components" | "github" | "security" | "networking" | "ports" | "terminal";
type ManualActionMode = "remove" | null;

interface TabDef {
  key: Tab;
  /** Narrower than ElementType so these feed the shared <Tabs> directly. */
  icon: IconName;
  /** Desktop-only tabs are filtered out in non-desktop deployments. */
  desktopOnly?: boolean;
}

// Mail management lives in /emails - that page picks any server and reads
// its mail-install state at runtime. We don't repeat that UI here.
const TABS: TabDef[] = [
  { key: "overview",   icon: "grid" },
  { key: "activity",   icon: "history" },
  { key: "migrations", icon: "migration" },
  { key: "components", icon: "server-settings" },
  { key: "github",     icon: "git-branch" },
  { key: "security",   icon: "shield" },
  { key: "networking", icon: "network" },
  // Port forwarding is meaningful only in desktop mode (the orchestrator IS
  // the user's machine); hidden elsewhere.
  { key: "ports",      icon: "port-forwarding", desktopOnly: true },
  { key: "terminal",   icon: "terminal" },
];

export default function ServerDetailPage({
  params,
}: {
  params: Promise<{ serverId: string }>;
}) {
  const { serverId } = use(params);
  return <ServerDetail key={serverId} serverId={serverId} />;
}

function ServerDetail({ serverId }: { serverId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const editing = searchParams.get("edit") === "true";
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const { t } = useI18n();
  // Port forwarding is meaningful only in desktop mode (the orchestrator IS
  // the user's machine). Backend routes are independently gated by assertDesktop.
  const { deployMode } = usePlatform();
  const isDesktop = deployMode === "desktop";
  // Single source of truth for saved port-forwards: drives the "Ports" tab
  // count badge (live even when the card is unmounted) AND the card's list.
  // No-ops off desktop, where the feature is gated away.
  const {
    tunnels,
    loading: tunnelsLoading,
    refresh: refreshTunnels,
  } = useServerTunnels(isDesktop ? serverId : null);
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [components, setComponents] = useState<ComponentStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fetching = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const managed = server?.managed;
  const hostConfiguration = server?.capabilities?.hostConfiguration ?? !managed;
  const ready = !managed || ["ready", "running", "active"].includes(managed.state);
  const canInspect = !!server && (server.capabilities?.exec ?? !managed) && ready;
  const canMonitor = (server?.capabilities?.monitor ?? !managed) && ready;
  const canTerminal = (server?.capabilities?.terminal ?? !managed) && ready;
  const managedActions = useManagedServerActions(serverId, row => {
    setServer(current => current ? { ...current, name: row.name, managed: row, projectCount: row.projectCount } : current);
  });
  const pending = ["queued", "running"].includes(managed?.operation?.status ?? "");
  const deleting = useRef(false);
  deleting.current = managed?.state === "deleting" || (pending && managed?.operation?.kind === "delete");
  const [checking, setChecking] = useState(false);
  const healthCheckPending = useRef(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkErrorKind, setCheckErrorKind] = useState<ConnectionErrorKind | null>(null);
  /** Endpoint + remedy the API attached to the failure (host-channel case). */
  const [checkDiagnosis, setCheckDiagnosis] = useState<ConnectionDiagnosis | undefined>(undefined);
  const [installLogs, setInstallLogs] = useState<SetupLogEvent[]>([]);
  const [requestedTab, setActiveTab] = useState<Tab>("overview");
  const visibleTabs = TABS.filter(tab => {
    if (tab.desktopOnly && !isDesktop) return false;
    if (tab.key === "activity") return !!managed;
    if (tab.key === "terminal") return canTerminal;
    if (tab.key === "networking") return !!server?.capabilities?.networkSettings;
    if (tab.key === "components" || tab.key === "security") return canInspect;
    return tab.key === "overview" || hostConfiguration;
  });
  const activeTab = visibleTabs.some(tab => tab.key === requestedTab) ? requestedTab : "overview";
  // Deep-link support: honour ?tab= once on mount (e.g. ?tab=github to land
  // straight on the GitHub connect tab).
  const tabParamApplied = useRef(false);
  useEffect(() => {
    if (tabParamApplied.current) return;
    tabParamApplied.current = true;
    const tab = searchParams.get("tab");
    if (tab && TABS.some((td) => td.key === tab)) setActiveTab(tab as Tab);
  }, [searchParams]);
  // Switch tab AND persist it in the URL (?tab=), so a reload / "service restart"
  // reopens the same tab. Shallow replace (no scroll) preserves other params.
  const changeTab = useCallback(
    (key: Tab) => {
      setActiveTab(key);
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      params.set("tab", key);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );
  // Real URL for each tab (`?tab=`, other params preserved) so the tabs are
  // proper links — cmd/ctrl/middle-click opens the tab in a new browser tab,
  // and the link is copyable. Plain clicks still switch client-side via changeTab.
  const tabHref = useCallback(
    (key: Tab) => {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      params.set("tab", key);
      return `${pathname}?${params.toString()}`;
    },
    [searchParams, pathname],
  );
  const [isRemoving, setIsRemoving] = useState(false);
  const [activeActionComponent, setActiveActionComponent] = useState<string | null>(null);
  const [manualActionComponents, setManualActionComponents] = useState<SetupComponentProgress[]>([]);
  const [manualActionMode, setManualActionMode] = useState<ManualActionMode>(null);
  const [manualActionDone, setManualActionDone] = useState(false);
  const [manualActionFinalStatus, setManualActionFinalStatus] = useState<"completed" | "failed" | null>(null);

  const setupStream = useSetupStream({
    onComplete: (event) => {
      // Re-run health check after install finishes
      void (async () => {
        try {
          if (!serverId) return;
          const result = await systemApi.checkServer(serverId);
          setComponents(result.components);
          setActiveActionComponent(null);
          if (event.status === "completed") {
            showToast(t.servers.detail.toastComponentActionCompleted, "success", t.servers.toastTitles.serverSetup);
          } else {
            showToast(t.servers.detail.toastSomeActionsFailed, "error", t.servers.toastTitles.serverSetup);
          }
        } catch (err) {
          const message = getApiErrorMessage(err, t.servers.detail.toastHealthCheckFailedAfterInstall);
          setCheckError(message);
          showToast(message, "error", t.servers.toastTitles.serverSetup);
        }
      })();
    },
    onLog: (entry) => {
      setInstallLogs((prev) => [...prev, entry]);
    },
  });

  const monitor = useMonitorStream(server ? serverId : null, activeTab === "overview" && canMonitor);

  // Mid-install prompt (e.g. OpenResty edge takeover) — the SAME generic prompt
  // modal the deploy pipeline uses. Surfaced only when an install hits a
  // port-80/443 conflict; answering it resumes the install.
  const promptModalRef = useRef<string | null>(null);
  const pendingPrompt = setupStream.pendingPrompt;
  const respondToPrompt = setupStream.respondToPrompt;
  useEffect(() => {
    if (!pendingPrompt) {
      promptModalRef.current = null;
      return;
    }
    if (promptModalRef.current === pendingPrompt.promptId) return;
    promptModalRef.current = pendingPrompt.promptId;

    const modalId = showModal({
      title: pendingPrompt.title,
      icon: "warning",
      width: "100%",
      maxWidth: "34rem",
      customContent: (
        <div className="p-6 space-y-5">
          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground">{pendingPrompt.title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{pendingPrompt.message}</p>
          </div>
          <PromptDetails details={pendingPrompt.details} />
          <div className="flex items-center justify-end gap-3 pt-2">
            {pendingPrompt.actions.map((action) => {
              const variant = (action.variant || "secondary") as "secondary" | "danger" | "primary";
              const styles =
                variant === "danger"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : variant === "primary"
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "border border-border bg-muted text-foreground hover:bg-muted/80";
              return (
                <button
                  key={action.id}
                  type="button"
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${styles}`}
                  onClick={() => {
                    hideModal(modalId);
                    void respondToPrompt(action.id);
                  }}
                >
                  {action.label}
                </button>
              );
            })}
          </div>
        </div>
      ),
    });
  }, [pendingPrompt, respondToPrompt, showModal, hideModal]);

  const fetchData = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    setRefreshing(true);
    try {
      const value = await systemApi.getServerById(serverId);
      if (!mounted.current) return;
      setServer(value);
      setLoadError(null);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError && error.status === 404) {
        if (deleting.current) router.replace("/servers");
        else setServer(null);
      } else setLoadError(getApiErrorMessage(error));
    } finally {
      fetching.current = false;
      if (mounted.current) { setLoading(false); setRefreshing(false); }
    }
  }, [serverId, router]);

  useEffect(() => { void fetchData(); }, [fetchData]);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void fetchData(); }, 3_000);
    return () => clearInterval(timer);
  }, [pending, fetchData]);

  const runHealthCheck = useCallback(async () => {
    if (!serverId || !canInspect || healthCheckPending.current) return;
    healthCheckPending.current = true;
    setChecking(true);
    setCheckError(null);
    setCheckErrorKind(null);
    setCheckDiagnosis(undefined);
    try {
      const result = await systemApi.checkServer(serverId);
      if (!mounted.current) return;
      setComponents(result.components);
    } catch (err) {
      if (!mounted.current) return;
      const message = getApiErrorMessage(err, t.servers.detail.toastHealthCheckFailed);
      const body = err instanceof ApiError ? err.body : undefined;
      const kind = classifyConnectionError(body, message);
      setComponents([]);
      setCheckError(message);
      setCheckErrorKind(kind);
      setCheckDiagnosis(readConnectionDiagnosis(body));
      // The inline banner is the primary surface - only toast for unexpected
      // shapes so the user isn't getting both a toast and a banner for the
      // same problem.
      if (hostConfiguration && kind === "unknown") {
        showToast(message, "error", t.servers.toastTitles.serverCheck);
      }
    } finally {
      healthCheckPending.current = false;
      if (mounted.current) setChecking(false);
    }
  }, [serverId, canInspect, hostConfiguration, showToast, t]);

  const installMissingComponents = useCallback(async () => {
    const missing = components.filter(
      (component) =>
        !component.healthy && component.installable,
    );

    if (missing.length === 0) {
      showToast(t.servers.detail.toastNoInstallableMissing, "success", t.servers.toastTitles.serverSetup);
      return;
    }

    setActiveActionComponent(null);
    setManualActionComponents([]);
    setManualActionMode(null);
    setManualActionDone(false);
    setManualActionFinalStatus(null);
    setCheckError(null);
    setInstallLogs([]);
    setActiveTab("components");

    try {
      if (!serverId) {
        showToast(t.servers.detail.toastServerMissing, "error", t.servers.toastTitles.serverSetup);
        return;
      }
      await setupStream.startInstall(serverId, missing.map((c) => c.name));
    } catch (err) {
      const message = getApiErrorMessage(err, t.servers.detail.toastFailedStartInstall);
      setCheckError(message);
      showToast(message, "error", t.servers.toastTitles.serverSetup);
    }
  }, [components, serverId, showToast, setupStream, t]);

  const startComponentAction = useCallback(async (component: ComponentStatus) => {
    if (!serverId) {
      showToast(t.servers.detail.toastServerMissing, "error", t.servers.toastTitles.serverSetup);
      return;
    }

    setActiveActionComponent(component.name);
    setManualActionComponents([]);
    setManualActionMode(null);
    setManualActionDone(false);
    setManualActionFinalStatus(null);
    setCheckError(null);
    setInstallLogs([]);
    setActiveTab("components");

    try {
      // This button reads "Reinstall"/"Update" on an installed component, so it
      // means it: installers that skip an already-working component (Docker, #491)
      // need the explicit opt-in to run at all. Install-missing and the setup flow
      // never send it, which is the point — they get the skip.
      await setupStream.startInstall(
        serverId,
        [component.name],
        component.installed ? { reinstall: true } : undefined,
      );
    } catch (err) {
      const message = getApiErrorMessage(err, interpolate(t.servers.detail.toastFailedRun, { label: component.label }));
      setCheckError(message);
      showToast(message, "error", t.servers.toastTitles.serverSetup);
    }
  }, [serverId, setupStream, showToast, t]);

  const runComponentAction = useCallback(async (component: ComponentStatus) => {
    // Reinstalling Docker restarts the daemon, which restarts every container on
    // the box — Openship's own stack included. That used to happen as an invisible
    // side effect of steps that merely needed Docker present (#491); now it happens
    // only here, and only after the operator is told what it costs.
    if (component.name === "docker" && component.installed) {
      const modalId = showModal({
        title: t.servers.detail.reinstallDockerTitle,
        message: t.servers.detail.reinstallDockerMessage,
        icon: "warning",
        width: "100%",
        maxWidth: "32rem",
        buttons: [
          {
            label: t.servers.detail.cancel,
            variant: "secondary",
            onClick: () => hideModal(modalId),
          },
          {
            label: t.servers.components.reinstall,
            variant: "danger",
            onClick: () => {
              hideModal(modalId);
              void startComponentAction(component);
            },
          },
        ],
      });
      return;
    }
    await startComponentAction(component);
  }, [hideModal, showModal, startComponentAction, t]);

  const removeComponentAction = useCallback((component: ComponentStatus) => {
    const modalId = showModal({
      title: interpolate(t.servers.detail.removeComponentTitle, { label: component.label }),
      message:
        component.name === "edge"
          ? t.servers.detail.removeOpenrestyMessage
          : interpolate(t.servers.detail.removeComponentMessage, { label: component.label }),
      icon: "warning",
      width: "100%",
      maxWidth: "32rem",
      buttons: [
        {
          label: t.servers.detail.cancel,
          variant: "secondary",
          onClick: () => hideModal(modalId),
        },
        {
          label: t.servers.detail.remove,
          variant: "danger",
          onClick: async () => {
            hideModal(modalId);
            if (!serverId) {
              showToast(t.servers.detail.toastServerMissing, "error", t.servers.toastTitles.serverSetup);
              return;
            }

            try {
              setActiveActionComponent(component.name);
              setIsRemoving(true);
              setManualActionMode("remove");
              setManualActionDone(false);
              setManualActionFinalStatus(null);
              setManualActionComponents([
                {
                  name: component.name,
                  label: component.label,
                  status: "removing",
                },
              ]);
              setCheckError(null);
              setInstallLogs([]);
              setActiveTab("components");
              const result = await systemApi.removeComponent(serverId, component.name);
              if (!result.success) {
                setInstallLogs((result.logs ?? []).map((message) => ({
                  type: "log",
                  timestamp: new Date().toISOString(),
                  component: component.name,
                  message,
                  level: "error" as const,
                })));
                setManualActionComponents([
                  {
                    name: component.name,
                    label: component.label,
                    status: "failed",
                    error: result.error || interpolate(t.servers.detail.toastFailedRemove, { label: component.label }),
                  },
                ]);
                setManualActionDone(true);
                setManualActionFinalStatus("failed");
                throw new Error(result.error || interpolate(t.servers.detail.toastFailedRemove, { label: component.label }));
              }

              setInstallLogs((result.logs ?? []).map((message) => ({
                type: "log",
                timestamp: new Date().toISOString(),
                component: component.name,
                message,
                level: "info" as const,
              })));
              setManualActionComponents([
                {
                  name: component.name,
                  label: component.label,
                  status: "removed",
                },
              ]);
              setManualActionDone(true);
              setManualActionFinalStatus("completed");

              const next = await systemApi.checkServer(serverId);
              setComponents(next.components);
              showToast(interpolate(t.servers.detail.toastComponentRemoved, { label: component.label }), "success", t.servers.toastTitles.serverSetup);
            } catch (err) {
              if (isAbortError(err)) {
                // Request timed out but removal may still be running server-side
                setManualActionComponents([{
                  name: component.name,
                  label: component.label,
                  status: "failed",
                  error: t.servers.detail.removalTakingLonger,
                }]);
                setManualActionDone(true);
                setManualActionFinalStatus("failed");
                setCheckError(t.servers.detail.removalTimedOutError);
                showToast(t.servers.detail.toastRemovalTimedOut, "error", t.servers.toastTitles.serverSetup);
              } else {
                const message = getApiErrorMessage(err, interpolate(t.servers.detail.toastFailedRemove, { label: component.label }));
                setCheckError(message);
                showToast(message, "error", t.servers.toastTitles.serverSetup);
              }
            } finally {
              setActiveActionComponent(null);
              setIsRemoving(false);
            }
          },
        },
      ],
    });
  }, [hideModal, serverId, showModal, showToast, t]);

  useEffect(() => {
    if (!canInspect) return;
    void runHealthCheck();
  }, [canInspect, runHealthCheck]);

  useEffect(() => {
    if (!server || !hostConfiguration) return;
    // Check for active install session (page reload recovery)
    void (async () => {
      try {
        const session = await systemApi.getInstallSession();
        if (
          session.active &&
          session.status === "running" &&
          session.sessionId &&
          session.serverId === serverId
        ) {
          setActiveTab("components");
          void setupStream.attachToSession(session.sessionId);
        }
      } catch {
        // No active session
      }
    })();
  }, [server?.id, hostConfiguration]); // eslint-disable-line react-hooks/exhaustive-deps

  const [removeOpen, setRemoveOpen] = useState(searchParams.get("remove") === "true");
  const handleDelete = useCallback(() => setRemoveOpen(true), []);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <UiIcon name="spinner" className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!server && loadError) return <PageContainer><div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-card p-5 text-sm"><p className="text-danger">{loadError}</p><Button variant="secondary" disabled={refreshing} onClick={() => void fetchData()}>{t.billing.plansRoute.tryAgain}</Button></div></PageContainer>;

  if (!server) {
    return (
      <PageContainer>
        <div className="flex min-h-[60vh] items-center justify-center p-6">
          <ResourceNotFound
            icon={<UiIcon name="server-error" className="size-7" />}
            title={t.servers.detail.serverNotFound}
            description={t.servers.detail.serverNotFoundDesc}
            detail={serverId}
            detailCopyLabel={t.chrome.notFound.copyId}
            actions={[
              {
                label: t.servers.setup.goToServers,
                icon: <UiIcon name="arrow-left" className="size-4 rtl:rotate-180" />,
                onClick: () => router.push("/servers"),
              },
            ]}
          />
        </div>
      </PageContainer>
    );
  }

  // Edit view shares the same route as the detail page (?edit=true) and reuses
  // the credentials form so add/edit stay in sync.
  if (editing) {
    return (
      <PageContainer>
          <div className="flex items-center gap-3 mb-6">
            <button
              onClick={() => router.push(`/servers/${serverId}`)}
              className="w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center transition-colors"
            >
              <UiIcon name="arrow-left" className="size-4 text-muted-foreground rtl:rotate-180" />
            </button>
            <div>
              <h1
                className="text-2xl font-medium text-foreground/80"
                style={{ letterSpacing: "-0.2px" }}
              >
                {t.servers.detail.editServer}
              </h1>
              <p className="text-sm text-muted-foreground/70 mt-0.5">
                {interpolate(t.servers.detail.editSubtitle, { name: server.name || server.sshHost || server.id })}
              </p>
            </div>
          </div>

          <div className="max-w-2xl">
            <ServerForm
              key={server.id}
              server={server}
              submitLabel={t.servers.detail.saveChanges}
              onSaved={({ server: updated }) => {
                setServer(updated);
                router.push(`/servers/${serverId}`);
              }}
            />
          </div>
      </PageContainer>
    );
  }

  const allHealthy =
    components.length > 0 && components.every((c) => c.healthy);
  const actionBusy = setupStream.isConnected || setupStream.isConnecting || isRemoving;
  const visibleActionComponents = manualActionComponents.length > 0
    ? manualActionComponents
    : setupStream.components;
  const visibleActionMode = manualActionComponents.length > 0
    ? manualActionMode ?? "remove"
    : "install";
  const visibleActionDone = manualActionComponents.length > 0
    ? manualActionDone
    : setupStream.isDone;
  const visibleActionFinalStatus = manualActionComponents.length > 0
    ? manualActionFinalStatus
    : setupStream.finalStatus;

  return (
    <PageContainer className="@container/server-detail">
        {/* The description spans the header so action buttons cannot squeeze it. */}
        <div className="mb-6 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 [.is-desktop_&]:grid-cols-[minmax(0,1fr)_auto]">
          {/* `app-nav-fallback` hides this in the desktop app, where the titlebar
              already carries back/forward. It stays on web/SaaS, which has no
              titlebar and would otherwise leave no way out of this page. */}
          <button
            onClick={() => router.push("/servers")}
            className="app-nav-fallback w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center transition-colors"
            aria-label={t.servers.setup.goToServers}
          >
            <UiIcon name="arrow-left" className="size-4 text-muted-foreground rtl:rotate-180" />
          </button>
          <div className="min-w-0">
            <h1
              className="text-2xl font-medium text-foreground/80 truncate"
              style={{ letterSpacing: "-0.2px" }}
            >
              {server.name || <BlurIp>{server.sshHost ?? server.id}</BlurIp>}
            </h1>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => router.push(`/servers/${serverId}?edit=true`)}
              aria-label={t.servers.detail.edit}
              className="inline-flex size-9 items-center justify-center gap-2 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors sm:w-auto sm:px-4"
            >
              <UiIcon name="sliders" className="size-4" />
              <span className="hidden sm:inline">{t.servers.detail.edit}</span>
            </button>
            <Button variant="ghost" size="icon" disabled={refreshing || checking} aria-label={t.servers.networks.refresh} onClick={() => { void fetchData(); void runHealthCheck(); monitor.reconnect(); }}><UiIcon name="refresh" className={`size-4 ${refreshing || checking ? "animate-spin" : ""}`} /></Button>
            {!server.isLocal && <DropdownMenu triggerLabel={t.servers.detail.removeServer} actions={[{ id: "remove", label: t.servers.detail.removeServer, icon: <UiIcon name="trash" className="size-4" />, variant: "danger", onClick: handleDelete }]} />}
          </div>
          <div className="col-span-2 col-start-2 flex min-w-0 flex-wrap items-center gap-2 [.is-desktop_&]:col-start-1">
            {managed ? <><p className="text-sm text-muted-foreground">{t.billing.workspaces.managedBy}</p><ManagedServerStatus workspace={managed} /></> : <>
              <p className="min-w-0 break-all text-sm text-muted-foreground font-mono">{server.sshUser ?? "root"}@<BlurIp>{server.sshHost ?? ""}</BlurIp></p>
              {allHealthy ? <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">{t.servers.detail.healthy}</span> : components.length > 0 ? <span className="rounded-full bg-warning/10 text-xs px-2 py-0.5 text-warning">{t.servers.detail.issues}</span> : null}
            </>}
          </div>
        </div>

        {/* Connection error banner - surfaces SSH-unreachable / auth-failed /
            mis-configured state above the tabs so the user has context the
            moment they open the page, not just a toast that disappears. */}
        {hostConfiguration && checkErrorKind && checkError && (
          <ConnectionBanner
            serverId={serverId}
            kind={checkErrorKind}
            host={server.sshHost ?? ""}
            port={server.sshPort ?? 22}
            message={checkError}
            retrying={checking}
            onRetry={runHealthCheck}
            diagnosis={checkDiagnosis}
          />
        )}
        {!hostConfiguration && checkError && activeTab !== "components" && (
          <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-warning-bg p-4">
            <p className="min-w-0 break-words text-sm text-foreground">{checkError}</p>
            <Button size="sm" variant="secondary" disabled={checking || !canInspect} onClick={runHealthCheck}>
              {checking ? t.servers.components.checking : t.servers.components.recheck}
            </Button>
          </div>
        )}

        {/* Tabs — the SHARED <Tabs> component, the same one the servers LIST uses,
            so the two pages can't drift apart in size/spacing (this bar used to be
            a hand-rolled copy of it). `href` keeps the tabs deep-linkable and
            cmd-clickable; a plain click still switches client-side. */}
        <Tabs
          className="mb-6"
          value={activeTab}
          onChange={(key) => changeTab(key)}
          tabs={visibleTabs.map(({ key, icon, desktopOnly }) => ({
            key,
            label: key === "networking" ? t.servers.tabsNav.networking : t.servers.detail.tabs[key],
            icon,
            href: tabHref(key),
            hidden: desktopOnly && !isDesktop,
            // Show how many forwards (running + stopped) are saved on this server.
            count: key === "ports" && isDesktop ? tunnels.length : undefined,
          }))}
        />

        {/* Main Grid — the Migrations tab spans full width (its flow renders its
            own right column: connection card → migrate config / live progress). */}
        <div className={`grid grid-cols-1 gap-6 items-start ${activeTab === "migrations" ? "" : "@min-[60rem]/server-detail:grid-cols-[minmax(0,1fr)_340px]"}`}>
          {/* Left column */}
          <div className="min-w-0 space-y-5">
            {loadError && <p role="alert" className="rounded-xl bg-danger/5 p-4 text-sm text-danger">{loadError}</p>}
            {managed && <ManagedServerActionFeedback server={managed} actions={managedActions} deleting={removeOpen} onCancelDelete={() => setRemoveOpen(false)} />}
            {/* Tab content */}
            {activeTab === "activity" && managed && <ManagedServerActivity server={managed} actions={managedActions} />}
            {activeTab === "overview" && <>
              {canMonitor && <OverviewTab
                stats={monitor.stats}
                components={components}
                checking={checking}
                monitorConnected={monitor.isConnected}
                monitorError={monitor.error}
                onReconnectMonitor={monitor.reconnect}
                showComponents={canInspect}
              />}
              <ServerUsage key={`${serverId}:${managed?.state ?? "connected"}`} serverId={serverId} resources={managed?.resources} showProjects metrics={!canMonitor} />
            </>}

            {activeTab === "components" && (
              <>
              {hostConfiguration && <ServerContainerUpdates serverId={serverId} />}
              {hostConfiguration && <ServerModuleUpdates serverId={serverId} />}
              <ComponentsTab
                components={components}
                checking={checking}
                checkError={checkError}
                onRecheck={runHealthCheck}
                onInstallMissing={installMissingComponents}
                onRunComponentAction={runComponentAction}
                onRemoveComponentAction={removeComponentAction}
                busy={actionBusy}
                activeActionComponent={activeActionComponent}
                installDone={visibleActionDone}
                installFinalStatus={visibleActionFinalStatus}
                installComponents={visibleActionComponents}
                actionMode={visibleActionMode}
                installLogs={installLogs}
                onDismissInstall={() => {
                  setInstallLogs([]);
                  setManualActionComponents([]);
                  setManualActionMode(null);
                  setManualActionDone(false);
                  setManualActionFinalStatus(null);
                }}
              />
              </>
            )}

            {activeTab === "github" && serverId && (
              <ServerGitHubConnect serverId={serverId} variant="card" />
            )}

            {activeTab === "security" && (
              <div className="space-y-6">
                <ExposedPortsCard serverId={serverId} managedIngress={!!managed} />
                {hostConfiguration && <RateLimitSettings serverId={serverId} />}
              </div>
            )}
            {activeTab === "networking" && <ManagedServerNetwork key={serverId} serverId={serverId} />}

            {activeTab === "ports" && isDesktop && serverId && (
              <PortForwardingCard
                serverId={serverId}
                tunnels={tunnels}
                loading={tunnelsLoading}
                refresh={refreshTunnels}
              />
            )}

            {activeTab === "terminal" && (
              <TerminalTab
                serverId={serverId}
                serverName={server?.name ?? undefined}
                maxShells={server?.terminalSessionLimit}
                enabled={activeTab === "terminal"}
              />
            )}

            {/* Migrations — durable run list (rows like a project's deployments)
                that opens each run's steps + logs IN-PAGE, plus the scan-first
                migrate flow (both are the reused ServerMigrationWizard). Kept
                MOUNTED (visibility-toggled) so a scan/flow survives tab switches. */}
            {hostConfiguration && serverId && (
              <div className={activeTab === "migrations" ? "" : "hidden"}>
                <MigrationsTab serverId={serverId} server={{ ...server, sshHost: server.sshHost ?? "" }} />
              </div>
            )}
          </div>

          {/* Right sidebar — connection summary. Hidden on the Migrations tab,
              whose flow renders its own right column. */}
          {activeTab !== "migrations" && (
            <div className="space-y-4 @min-[60rem]/server-detail:sticky @min-[60rem]/server-detail:top-6 @min-[60rem]/server-detail:self-start">
              {managed ? <ManagedServerPlan server={managed} actions={managedActions} /> : <><ServerConnectionCard server={{ ...server, sshHost: server.sshHost ?? "" }} /><ServerInfrastructure serverId={serverId} /></>}
            </div>
          )}
        </div>

        {!managed && <ServerDeletionModal
          isOpen={removeOpen}
          onClose={() => setRemoveOpen(false)}
          onRemoved={() => router.push("/servers")}
          key={serverId}
          serverId={serverId}
          serverName={server?.name ?? ""}
        />}
    </PageContainer>
  );
}
