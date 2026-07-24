"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  ArrowLeft,
  Loader2,
  Settings2,
  Trash2,
  LayoutGrid,
  Blocks,
  Boxes,
  Terminal,
  MoreHorizontal,
  Server,
  ServerCrash,
  Globe,
  User,
  KeyRound,
  Shield,
  Network,
  GitBranch,
} from "lucide-react";
import { ApiError, getApiErrorMessage, isAbortError, systemApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useModal } from "@/context/ModalContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { PageContainer } from "@/components/ui/PageContainer";
import { ResourceNotFound } from "@/components/resource-not-found";
import { useSetupStream } from "@/hooks/useSetupStream";
import { useMonitorStream } from "@/hooks/useMonitorStream";
import type { ServerInfo, ComponentStatus, SetupComponentProgress, SetupLogEvent } from "@/lib/api/system";
import { PromptDetails } from "@/components/import-project/PromptDetails";
import { ServerForm } from "../_components/server-form";
import { OverviewTab } from "./_components/overview-tab";
import { ComponentsTab } from "./_components/components-tab";
import { ServerModuleUpdates } from "./_components/module-updates";
import { TerminalTab } from "./_components/terminal-tab";
import {
  ConnectionBanner,
  classifyConnectionError,
  type ConnectionErrorKind,
} from "./_components/connection-banner";

import { RateLimitSettings } from "./_components/rate-limit-settings";
import { ExposedPortsCard } from "./_components/exposed-ports-card";
import { PortForwardingCard } from "./_components/port-forwarding-card";
import { ServerGitHubConnect } from "@/components/github/ServerGitHubConnect";
import { ServerMigrationWizard } from "@/components/migration/ServerMigrationWizard";
import { ServerConnectionCard } from "./_components/connection-card";
import { usePlatform } from "@/context/PlatformContext";
import * as CountryFlags from "country-flag-icons/react/3x2";

/** ISO-3166-1 alpha-2 → flag component (same source the servers list uses). */
const FLAGS = CountryFlags as Record<string, React.ComponentType<{ title?: string; className?: string }>>;

type Tab = "overview" | "services" | "components" | "github" | "security" | "ports" | "terminal";
type ManualActionMode = "remove" | null;

interface TabDef {
  key: Tab;
  icon: React.ElementType;
  /** Desktop-only tabs are filtered out in non-desktop deployments. */
  desktopOnly?: boolean;
}

// Mail management lives in /emails - that page picks any server and reads
// its mail-install state at runtime. We don't repeat that UI here.
const TABS: TabDef[] = [
  { key: "overview",   icon: LayoutGrid },
  { key: "services",   icon: Boxes },
  { key: "components", icon: Blocks },
  { key: "github",     icon: GitBranch },
  { key: "security",   icon: Shield },
  // Port forwarding is meaningful only in desktop mode (the orchestrator IS
  // the user's machine); hidden elsewhere.
  { key: "ports",      icon: Network, desktopOnly: true },
  { key: "terminal",   icon: Terminal },
];

export default function ServerDetailPage({
  params,
}: {
  params: Promise<{ serverId: string }>;
}) {
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
  const [serverId, setServerId] = useState<string>("");
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [components, setComponents] = useState<ComponentStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkErrorKind, setCheckErrorKind] = useState<ConnectionErrorKind | null>(null);
  const [installLogs, setInstallLogs] = useState<SetupLogEvent[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
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
  const [showMenu, setShowMenu] = useState(false);
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

  const monitor = useMonitorStream(serverId || null, activeTab === "overview");

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

  useEffect(() => {
    params.then((p) => setServerId(p.serverId));
  }, [params]);

  const fetchData = useCallback(async () => {
    if (!serverId) return;
    try {
      setLoading(true);
      const s = await systemApi.getServerById(serverId);
      setServer(s);
    } catch {
      setServer(null);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  const runHealthCheck = useCallback(async () => {
    if (!serverId) return;
    setChecking(true);
    setCheckError(null);
    setCheckErrorKind(null);
    try {
      const result = await systemApi.checkServer(serverId);
      setComponents(result.components);
    } catch (err) {
      const message = getApiErrorMessage(err, t.servers.detail.toastHealthCheckFailed);
      const body = err instanceof ApiError ? err.body : undefined;
      const kind = classifyConnectionError(body, message);
      setComponents([]);
      setCheckError(message);
      setCheckErrorKind(kind);
      // The inline banner is the primary surface - only toast for unexpected
      // shapes so the user isn't getting both a toast and a banner for the
      // same problem.
      if (kind === "unknown") {
        showToast(message, "error", t.servers.toastTitles.serverCheck);
      }
    } finally {
      setChecking(false);
    }
  }, [serverId, showToast, t]);

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

  const runComponentAction = useCallback(async (component: ComponentStatus) => {
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
      await setupStream.startInstall(serverId, [component.name]);
    } catch (err) {
      const message = getApiErrorMessage(err, interpolate(t.servers.detail.toastFailedRun, { label: component.label }));
      setCheckError(message);
      showToast(message, "error", t.servers.toastTitles.serverSetup);
    }
  }, [serverId, setupStream, showToast, t]);

  const removeComponentAction = useCallback((component: ComponentStatus) => {
    const modalId = showModal({
      title: interpolate(t.servers.detail.removeComponentTitle, { label: component.label }),
      message:
        component.name === "openresty"
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
    if (!serverId) return;
    fetchData();
    runHealthCheck();

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
  }, [serverId, fetchData, runHealthCheck]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDelete = useCallback(() => {
    const modalId = showModal({
      title: t.servers.detail.removeServer,
      message: t.servers.detail.removeServerMessage,
      icon: "warning",
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
            try {
              await systemApi.deleteServerEntry(serverId);
              hideModal(modalId);
              showToast(t.servers.detail.toastServerRemoved, "success", t.servers.toastTitles.server);
              router.push("/servers");
            } catch (err) {
              showToast(
                getApiErrorMessage(err, t.servers.detail.toastFailedRemoveServer),
                "error",
                t.servers.toastTitles.server,
              );
            }
          },
        },
      ],
    });
  }, [serverId, router, showToast, showModal, hideModal, t]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!server) {
    return (
      <PageContainer>
        <div className="flex min-h-[60vh] items-center justify-center p-6">
          <ResourceNotFound
            icon={<ServerCrash className="size-7" />}
            title={t.servers.detail.serverNotFound}
            description={t.servers.detail.serverNotFoundDesc}
            detail={serverId}
            detailCopyLabel={t.chrome.notFound.copyId}
            actions={[
              {
                label: t.servers.setup.goToServers,
                icon: <ArrowLeft className="size-4 rtl:rotate-180" />,
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
              <ArrowLeft className="size-4 text-muted-foreground rtl:rotate-180" />
            </button>
            <div>
              <h1
                className="text-2xl font-medium text-foreground/80"
                style={{ letterSpacing: "-0.2px" }}
              >
                {t.servers.detail.editServer}
              </h1>
              <p className="text-sm text-muted-foreground/70 mt-0.5">
                {interpolate(t.servers.detail.editSubtitle, { name: server.name || server.sshHost })}
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
    <PageContainer>
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => router.push("/servers")}
            className="w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center transition-colors"
          >
            <ArrowLeft className="size-4 text-muted-foreground rtl:rotate-180" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1
                className="text-2xl font-medium text-foreground/80 truncate"
                style={{ letterSpacing: "-0.2px" }}
              >
                {server.name || server.sshHost}
              </h1>
              {allHealthy ? (
                <span className="shrink-0 inline-flex items-center gap-1.5 text-success text-xs font-medium">
                  <span className="size-1.5 rounded-full bg-success" />
                  {t.servers.detail.healthy}
                </span>
              ) : components.length > 0 ? (
                <span className="shrink-0 inline-flex items-center gap-1.5 text-warning text-xs font-medium">
                  <span className="size-1.5 rounded-full bg-warning" />
                  {t.servers.detail.issues}
                </span>
              ) : null}
            </div>
            {/* Connection line: user@host + country flag. The SSH port lives in
                the right-hand connection card, not glued to the IP. */}
            <div className="mt-1 flex items-center gap-2">
              <p className="text-sm text-muted-foreground/70 font-mono">
                {server.sshUser ?? "root"}@{server.sshHost}
              </p>
              {(() => {
                const Flag = server.country ? FLAGS[server.country] : undefined;
                return Flag ? (
                  <Flag title={server.country ?? undefined} className="h-3.5 w-auto rounded-[2px] ring-1 ring-border/50" />
                ) : null;
              })()}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => changeTab("services")}
              className="inline-flex items-center gap-2 px-4 py-2 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors"
            >
              <Boxes className="size-4" />
              {t.migration.entry.action}
            </button>
            <button
              onClick={() => router.push(`/servers/${serverId}?edit=true`)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors"
            >
              <Settings2 className="size-4" />
              {t.servers.detail.edit}
            </button>
            <div className="relative">
              <button
                onClick={() => setShowMenu((v) => !v)}
                className="w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center transition-colors text-muted-foreground hover:text-foreground"
              >
                <MoreHorizontal className="size-4" />
              </button>
              {showMenu && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setShowMenu(false)}
                  />
                  <div className="absolute end-0 top-full mt-1 z-50 w-48 bg-popover border border-border rounded-xl shadow-lg py-1">
                    <button
                      onClick={() => {
                        setShowMenu(false);
                        handleDelete();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-danger hover:bg-danger-bg transition-colors"
                    >
                      <Trash2 className="size-3.5" />
                      {t.servers.detail.removeServer}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Connection error banner - surfaces SSH-unreachable / auth-failed /
            mis-configured state above the tabs so the user has context the
            moment they open the page, not just a toast that disappears. */}
        {checkErrorKind && checkError && (
          <ConnectionBanner
            serverId={serverId}
            kind={checkErrorKind}
            host={server.sshHost}
            port={server.sshPort ?? 22}
            message={checkError}
            retrying={checking}
            onRetry={runHealthCheck}
          />
        )}

        {/* Tabs — full-width above the grid so the bar is identical on every tab
            (including the single-column Services tab). */}
        <div className="flex items-center gap-1 mb-6 border-b border-border/50 overflow-x-auto">
          {TABS.filter((tab) => !tab.desktopOnly || isDesktop).map(({ key, icon: Icon }) => (
            <button
              key={key}
              onClick={() => changeTab(key)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors relative shrink-0 ${
                activeTab === key ? "text-foreground" : "text-muted-foreground hover:text-foreground/70"
              }`}
            >
              <Icon className="size-4" />
              {t.servers.detail.tabs[key]}
              {activeTab === key && (
                <span className="absolute bottom-0 start-0 end-0 h-0.5 bg-primary rounded-full" />
              )}
            </button>
          ))}
        </div>

        {/* Main Grid — the Services tab spans full width (it renders its own
            right column: connection card → migrate config after a scan). */}
        <div className={`grid grid-cols-1 gap-6 items-start ${activeTab === "services" ? "" : "lg:grid-cols-[1fr_340px]"}`}>
          {/* Left column */}
          <div className="min-w-0">

            {/* Tab content */}
            {activeTab === "overview" && (
              <OverviewTab
                stats={monitor.stats}
                components={components}
                checking={checking}
                monitorConnected={monitor.isConnected}
                monitorError={monitor.error}
                onReconnectMonitor={monitor.reconnect}
              />
            )}

            {activeTab === "components" && (
              <>
              {serverId && <ServerModuleUpdates serverId={serverId} />}
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
                <ExposedPortsCard serverId={serverId} />
                <RateLimitSettings serverId={serverId} />
              </div>
            )}

            {activeTab === "ports" && isDesktop && serverId && (
              <PortForwardingCard serverId={serverId} />
            )}

            {activeTab === "terminal" && (
              <TerminalTab
                serverId={serverId}
                serverName={server?.name ?? undefined}
                enabled={activeTab === "terminal"}
              />
            )}

            {/* Kept MOUNTED (visibility-toggled) so a scan + selection survive
                switching tabs — the migrate flow is stateful. */}
            {serverId && (
              <div className={activeTab === "services" ? "" : "hidden"}>
                <ServerMigrationWizard
                  variant="tab"
                  serverId={serverId}
                  server={server}
                  onClose={() => {}}
                />
              </div>
            )}
          </div>

          {/* Right sidebar — connection summary. Hidden on the Services tab, which
              renders its own right column (connection card → migrate config). */}
          {activeTab !== "services" && (
            <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
              <ServerConnectionCard server={server} />
            </div>
          )}
        </div>
    </PageContainer>
  );
}
