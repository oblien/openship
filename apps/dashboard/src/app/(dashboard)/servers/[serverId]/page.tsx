"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Loader2,
  Settings2,
  Trash2,
  LayoutGrid,
  Blocks,
  Terminal,
  MoreHorizontal,
  Server,
  Globe,
  User,
  KeyRound,
} from "lucide-react";
import { getApiErrorMessage, isAbortError, systemApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useModal } from "@/context/ModalContext";
import { useSetupStream } from "@/hooks/useSetupStream";
import { useMonitorStream } from "@/hooks/useMonitorStream";
import type { ServerInfo, ComponentStatus, SetupComponentProgress, SetupLogEvent } from "@/lib/api/system";
import { OverviewTab } from "./_components/overview-tab";
import { ComponentsTab } from "./_components/components-tab";
import { TerminalTab } from "./_components/terminal-tab";

type Tab = "overview" | "components" | "terminal";
type ManualActionMode = "remove" | null;

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: "overview", label: "Overview", icon: LayoutGrid },
  { key: "components", label: "Components", icon: Blocks },
  { key: "terminal", label: "Terminal", icon: Terminal },
];

export default function ServerDetailPage({
  params,
}: {
  params: Promise<{ serverId: string }>;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const [serverId, setServerId] = useState<string>("");
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [components, setComponents] = useState<ComponentStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [installLogs, setInstallLogs] = useState<SetupLogEvent[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
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
            showToast("Component action completed", "success", "Server Setup");
          } else {
            showToast("Some component actions failed", "error", "Server Setup");
          }
        } catch (err) {
          const message = getApiErrorMessage(err, "Health check failed after install");
          setCheckError(message);
          showToast(message, "error", "Server Setup");
        }
      })();
    },
    onLog: (entry) => {
      setInstallLogs((prev) => [...prev, entry]);
    },
  });

  const monitor = useMonitorStream(serverId || null, activeTab === "overview");

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
    try {
      const result = await systemApi.checkServer(serverId);
      setComponents(result.components);
    } catch (err) {
      const message = getApiErrorMessage(err, "Health check failed");
      setComponents([]);
      setCheckError(message);
      showToast(message, "error", "Server Check");
    } finally {
      setChecking(false);
    }
  }, [serverId, showToast]);

  const installMissingComponents = useCallback(async () => {
    const missing = components.filter(
      (component) =>
        !component.healthy && component.installable,
    );

    if (missing.length === 0) {
      showToast("No installable components are missing", "success", "Server Setup");
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
        showToast("Server is missing", "error", "Server Setup");
        return;
      }
      await setupStream.startInstall(serverId, missing.map((c) => c.name));
    } catch (err) {
      const message = getApiErrorMessage(err, "Failed to start installation");
      setCheckError(message);
      showToast(message, "error", "Server Setup");
    }
  }, [components, serverId, showToast, setupStream]);

  const runComponentAction = useCallback(async (component: ComponentStatus) => {
    if (!serverId) {
      showToast("Server is missing", "error", "Server Setup");
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
      const message = getApiErrorMessage(err, `Failed to run ${component.label}`);
      setCheckError(message);
      showToast(message, "error", "Server Setup");
    }
  }, [serverId, setupStream, showToast]);

  const removeComponentAction = useCallback((component: ComponentStatus) => {
    const modalId = showModal({
      title: `Remove ${component.label}`,
      message:
        component.name === "openresty"
          ? "This removes OpenResty and its managed Lua/config files from the server. Use Reinstall when you only need to refresh analytics scripts or settings."
          : `This removes ${component.label} from the server. This is destructive and may disable related deployment features until you install it again.`,
      icon: "warning",
      width: "100%",
      maxWidth: "32rem",
      buttons: [
        {
          label: "Cancel",
          variant: "secondary",
          onClick: () => hideModal(modalId),
        },
        {
          label: "Remove",
          variant: "danger",
          onClick: async () => {
            hideModal(modalId);
            if (!serverId) {
              showToast("Server is missing", "error", "Server Setup");
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
                    error: result.error || `Failed to remove ${component.label}`,
                  },
                ]);
                setManualActionDone(true);
                setManualActionFinalStatus("failed");
                throw new Error(result.error || `Failed to remove ${component.label}`);
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
              showToast(`${component.label} removed`, "success", "Server Setup");
            } catch (err) {
              if (isAbortError(err)) {
                // Request timed out but removal may still be running server-side
                setManualActionComponents([{
                  name: component.name,
                  label: component.label,
                  status: "failed",
                  error: `Removal is taking longer than expected. Check the server status.`,
                }]);
                setManualActionDone(true);
                setManualActionFinalStatus("failed");
                setCheckError("Removal timed out — re-check the server to see the current status.");
                showToast("Removal timed out — re-check server status", "error", "Server Setup");
              } else {
                const message = getApiErrorMessage(err, `Failed to remove ${component.label}`);
                setCheckError(message);
                showToast(message, "error", "Server Setup");
              }
            } finally {
              setActiveActionComponent(null);
              setIsRemoving(false);
            }
          },
        },
      ],
    });
  }, [hideModal, serverId, showModal, showToast]);

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
      title: "Remove Server",
      message:
        "Are you sure? This will clear all SSH credentials and connection settings.",
      icon: "warning",
      buttons: [
        {
          label: "Cancel",
          variant: "secondary",
          onClick: () => hideModal(modalId),
        },
        {
          label: "Remove",
          variant: "danger",
          onClick: async () => {
            try {
              await systemApi.deleteServerEntry(serverId);
              hideModal(modalId);
              showToast("Server removed", "success", "Server");
              router.push("/servers");
            } catch (err) {
              showToast(
                getApiErrorMessage(err, "Failed to remove server"),
                "error",
                "Server",
              );
            }
          },
        },
      ],
    });
  }, [serverId, router, showToast, showModal, hideModal]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!server) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center gap-3 mb-6">
            <button
              onClick={() => router.push("/servers")}
              className="w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center transition-colors"
            >
              <ArrowLeft className="size-4 text-muted-foreground" />
            </button>
            <h1 className="text-2xl font-medium text-foreground/80">
              Server not found
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">
            No server configured with id &ldquo;{serverId}&rdquo;.
          </p>
        </div>
      </div>
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
    <div className="min-h-screen bg-background">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => router.push("/servers")}
            className="w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center transition-colors"
          >
            <ArrowLeft className="size-4 text-muted-foreground" />
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
                <div className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-medium rounded-full">
                  <CheckCircle2 className="size-3" />
                  Healthy
                </div>
              ) : components.length > 0 ? (
                <div className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 bg-orange-500/10 text-orange-600 dark:text-orange-400 text-xs font-medium rounded-full">
                  <XCircle className="size-3" />
                  Issues
                </div>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground/70 mt-1 font-mono">
              {server.sshUser ?? "root"}@{server.sshHost}:{server.sshPort ?? 22}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => router.push(`/servers/${serverId}/edit`)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors"
            >
              <Settings2 className="size-4" />
              Edit
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
                  <div className="absolute right-0 top-full mt-1 z-50 w-48 bg-popover border border-border rounded-xl shadow-lg py-1">
                    <button
                      onClick={() => {
                        setShowMenu(false);
                        handleDelete();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-500/5 transition-colors"
                    >
                      <Trash2 className="size-3.5" />
                      Remove Server
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
          {/* Left column */}
          <div className="min-w-0">
            {/* Tabs */}
            <div className="flex items-center gap-1 mb-6 border-b border-border/50">
              {TABS.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors relative ${
                    activeTab === key
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground/70"
                  }`}
                >
                  <Icon className="size-4" />
                  {label}
                  {activeTab === key && (
                    <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
                  )}
                </button>
              ))}
            </div>

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
            )}

            {activeTab === "terminal" && <TerminalTab />}
          </div>

          {/* Right sidebar — offset to align with tab content below tab bar */}
          <div className="lg:pt-[65px] space-y-4 lg:sticky lg:top-6 lg:self-start">
            {/* Server details */}
            <div className="bg-card rounded-2xl border border-border/50 p-5">
              <div className="flex items-center gap-2 mb-4">
                <Server className="size-4 text-muted-foreground" />
                <h3 className="font-semibold text-foreground text-sm">
                  Connection
                </h3>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-muted/60 flex items-center justify-center">
                      <Globe className="size-4 text-muted-foreground" />
                    </div>
                    <span className="text-sm text-muted-foreground">Host</span>
                  </div>
                  <span className="text-sm font-medium text-foreground font-mono truncate ml-3 max-w-[140px]">
                    {server.sshHost}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-muted/60 flex items-center justify-center">
                      <User className="size-4 text-muted-foreground" />
                    </div>
                    <span className="text-sm text-muted-foreground">User</span>
                  </div>
                  <span className="text-sm font-medium text-foreground font-mono">
                    {server.sshUser ?? "root"}
                  </span>
                </div>

                <div className="h-px bg-border/60 my-2" />

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-muted/60 flex items-center justify-center">
                      <KeyRound className="size-4 text-muted-foreground" />
                    </div>
                    <span className="text-sm text-muted-foreground">Auth</span>
                  </div>
                  <span className="text-sm font-medium text-foreground">
                    {server.sshAuthMethod === "key" ? "SSH Key" : "Password"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
