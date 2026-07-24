"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { usePlatform } from "@/context/PlatformContext";
import { useToast } from "@/context/ToastContext";
import {
  serviceKind,
  serviceUsesDeployPipeline,
  serviceCanStartWithoutBuild,
  servicesApi,
  type Service,
  type ServiceContainer,
  type ServiceInput,
} from "@/lib/api/services";
import { deployApi } from "@/lib/api/deploy";
import { resolveServiceHostnameLabel, internalServiceAddress } from "@repo/core";
import {
  Play,
  Square,
  Terminal,
  Variable,
  Loader2,
  Network,
  ExternalLink,
  Power,
  RotateCw,
  Rocket,
  ChevronDown,
  Copy,
  Check,
  HardDrive,
  Settings,
  Trash2,
  DatabaseBackup,
  PlayCircle,
  Plus,
  LayoutDashboard,
  ScrollText,
  Save,
} from "lucide-react";
import { backupsApi, getApiErrorMessage, type BackupPolicy } from "@/lib/api";
import { PolicyEditor } from "@/components/backup/PolicyEditor";
import { BackupRunCard } from "@/components/backup/BackupRunCard";
import { ServiceTerminal } from "@/components/terminal/ServiceTerminal";
import { useTheme } from "@/components/theme-provider";
import { Tabs, type TabDef } from "@/components/ui/Tabs";
import DropdownMenu from "@/components/ui/DropdownMenu";
import { ServiceSettingsForm } from "./ServiceSettingsForm";
import { TerminalLogs } from "../logs/TerminalLogs";
import EnvironmentVariables from "@/components/import-project/EnvironmentVariables";
import { endpoints } from "@/lib/api/endpoints";
import { useI18n, interpolate } from "@/components/i18n-provider";

type ServiceTab = "overview" | "terminal" | "logs" | "env" | "settings" | "backup";
const SERVICE_TAB_DEFS: TabDef<ServiceTab>[] = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "terminal", label: "Terminal", icon: Terminal },
  { key: "logs", label: "Logs", icon: ScrollText },
  { key: "env", label: "Environment", icon: Variable },
  { key: "settings", label: "Settings", icon: Settings },
  { key: "backup", label: "Backup", icon: DatabaseBackup },
];
const SERVICE_TABS = SERVICE_TAB_DEFS.map((t) => t.key);

type EnvRow = { key: string; value: string; visible: boolean };
const envRowsFromRecord = (value?: Record<string, string> | null): EnvRow[] =>
  Object.entries(value ?? {}).map(([key, val]) => ({ key, value: val, visible: true }));
const envRecordFromRows = (rows: EnvRow[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k) out[k] = r.value;
  }
  return out;
};

/* ── Props ──────────────────────────────────────────────────────────── */

interface ServiceDetailPanelProps {
  service: Service;
  container?: ServiceContainer;
  projectId: string;
  projectSlugBase: string;
  /** Tab to open on mount (from the URL: /services/[id]/[tab]). */
  initialTab?: string;
  onRefresh: () => void | Promise<void>;
  onDeleted?: () => void;
  /** Project context — supplied by the caller instead of read from
   *  ProjectSettingsContext, so the panel renders outside the projects route
   *  tree (e.g. the server-detail Services tab). The projects route passes these
   *  from `useProjectSettings()`. */
  projectType?: string;
  activeDeploymentId?: string | null;
  deployTarget?: string | null;
  /** Sibling services for the header switcher (same project). */
  siblingServices?: Service[];
  /** Deep-link the active tab into the URL (projects route). Off at server level. */
  deepLink?: boolean;
  /** Override the service switcher — server level swaps in place instead of
   *  routing to /projects/…. When omitted, routes as before. */
  onSwitchService?: (targetId: string, tab: string) => void;
}

/* ── Panel ──────────────────────────────────────────────────────────── */

export function ServiceDetailPanel({
  service,
  container,
  projectId,
  projectSlugBase,
  initialTab,
  onRefresh,
  onDeleted,
  projectType,
  activeDeploymentId,
  deployTarget,
  siblingServices,
  deepLink = true,
  onSwitchService,
}: ServiceDetailPanelProps) {
  const { baseDomain } = usePlatform();
  const { showToast } = useToast();
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const router = useRouter();
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [redeploying, setRedeploying] = useState(false);
  const status = container?.status ?? (service.enabled ? "stopped" : "disabled");

  // Backup only applies to compose services (stateful containers) — never
  // monorepo sub-apps (source-built frontends).
  const supportsBackup = serviceKind(service) === "compose";

  // Two-mode split (pipeline vs image app) + launchability — shared helpers so
  // this classification can't drift from the other call sites. See services.ts.
  const usesDeployPipeline = serviceUsesDeployPipeline(service, projectType);
  const canStartWithoutBuild = serviceCanStartWithoutBuild(service);

  // ── Tabs ─────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ServiceTab>(() =>
    SERVICE_TABS.includes(initialTab as ServiceTab) ? (initialTab as ServiceTab) : "overview",
  );
  const changeTab = (tab: ServiceTab) => {
    setActiveTab(tab);
    // Deep-link the tab without a route push (scroll-preserving), matching
    // ProjectSidebar's tab-sync so back/forward and refresh land on it. Skipped
    // off the projects route (server level) where that URL shape doesn't apply.
    if (deepLink && typeof window !== "undefined") {
      const scrollY = window.scrollY;
      window.history.replaceState({}, "", `/projects/${projectId}/services/${service.id}/${tab}`);
      requestAnimationFrame(() => window.scrollTo(0, scrollY));
    }
  };

  // ── Service switcher ─────────────────────────────────────────────────
  // Jump to another service WITHOUT leaving the current tab (Terminal stays
  // Terminal, Env stays Env, …). Routing carries the tab in the URL and the
  // panel is keyed by service id upstream, so it remounts cleanly on the same
  // tab. Backup is compose-only — fall back to Overview if the target can't
  // show it, so a switch never lands on an empty hidden tab.
  const switchableServices = siblingServices ?? [];
  const canSwitchService = switchableServices.length > 1;
  const switchService = (targetId: string) => {
    if (targetId === service.id) return;
    const target = switchableServices.find((s) => s.id === targetId);
    const targetTab =
      activeTab === "backup" && target && serviceKind(target) !== "compose" ? "overview" : activeTab;
    if (onSwitchService) onSwitchService(targetId, targetTab);
    else router.push(`/projects/${projectId}/services/${targetId}/${targetTab}`);
  };

  // ── Env tab state (editable; the panel used to show env read-only) ────
  const [envRows, setEnvRows] = useState<EnvRow[]>(() => envRowsFromRecord(service.environment));
  const [envSaving, setEnvSaving] = useState(false);
  useEffect(() => {
    setEnvRows(envRowsFromRecord(service.environment));
  }, [service.id, service.environment]);
  const envDirty = useMemo(
    () => JSON.stringify(envRecordFromRows(envRows)) !== JSON.stringify(service.environment ?? {}),
    [envRows, service.environment],
  );
  const handleSaveEnv = async () => {
    setEnvSaving(true);
    try {
      const result = await servicesApi.update(projectId, service.id, {
        environment: envRecordFromRows(envRows),
      });
      if (!result.success) throw new Error(t.projectDetail.services.detail.toast.envSaveFailed);
      await onRefresh();
      showToast(t.projectDetail.services.detail.toast.envUpdated, "success", service.name);
    } catch (err) {
      showToast(err instanceof Error ? err.message : t.projectDetail.services.detail.toast.envSaveFailed, "error");
    } finally {
      setEnvSaving(false);
    }
  };

  // ── Terminal section state ──────────────────────────────────────────
  // Lazy-mount: the WS only opens once the user opens the Terminal tab, so
  // service pages don't burn a session slot per page view. A resume token
  // persists per-service in localStorage so refresh / tab-switch reattaches
  // the parked session rather than spawning a fresh shell.
  const [terminalResumeToken, setTerminalResumeToken] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = `openship.serviceterm.resume.${service.id}`;
    setTerminalResumeToken(window.localStorage.getItem(key));
  }, [service.id]);
  const persistResumeToken = (token: string | null) => {
    setTerminalResumeToken(token);
    if (typeof window === "undefined") return;
    const key = `openship.serviceterm.resume.${service.id}`;
    if (token) window.localStorage.setItem(key, token);
    else window.localStorage.removeItem(key);
  };

  // ── Backup section state ────────────────────────────────────────────
  const [backupPolicy, setBackupPolicy] = useState<BackupPolicy | null>(null);
  const [backupEditorOpen, setBackupEditorOpen] = useState(false);
  const [activeBackupRunId, setActiveBackupRunId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void backupsApi
      .listPolicies(projectId)
      .then((res) => {
        if (!alive) return;
        const policy = res.data.find((p) => p.serviceId === service.id) ?? null;
        setBackupPolicy(policy);
      })
      .catch(() => {
        if (alive) setBackupPolicy(null);
      });
    return () => {
      alive = false;
    };
  }, [projectId, service.id]);

  const reloadBackupPolicy = async (): Promise<void> => {
    try {
      const res = await backupsApi.listPolicies(projectId);
      const policy = res.data.find((p) => p.serviceId === service.id) ?? null;
      setBackupPolicy(policy);
    } catch {
      // tolerated
    }
  };

  const handleBackupNow = async (): Promise<void> => {
    if (!backupPolicy) return;
    try {
      const res = await backupsApi.runNow(backupPolicy.id);
      setActiveBackupRunId(res.data.runId);
    } catch (err) {
      window.alert(getApiErrorMessage(err, t.projectDetail.services.detail.toast.backupRunFailed));
    }
  };

  const resolvedUrl = service.exposed
    ? service.domainType === "custom" && service.customDomain
      ? `https://${service.customDomain}`
      : `https://${resolveServiceHostnameLabel(projectSlugBase, service.name, service.domain, serviceKind(service))}.${baseDomain}`
    : null;

  // Hero subtitle: the image, or the build context — but not a bare "." (the
  // default compose build context), which reads as a stray dot.
  const sourceLabel =
    service.image?.trim() ||
    (service.build && service.build.trim() && service.build.trim() !== "."
      ? service.build.trim()
      : "");

  const copy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  /* ── Handlers ───────────────────────────────────────────────── */

  const handleContainerAction = async (action: "start" | "stop" | "restart") => {
    setActionLoading(action);
    try {
      if (action === "start") await servicesApi.start(projectId, service.id);
      else if (action === "stop") await servicesApi.stop(projectId, service.id);
      else await servicesApi.restart(projectId, service.id);
      onRefresh();
    } catch (err) {
      showToast(
        getApiErrorMessage(err, t.projectDetail.services.detail.toast.deployFailed),
        "error",
        service.name,
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handleToggleEnabled = async () => {
    setSaving(true);
    try {
      await servicesApi.update(projectId, service.id, { enabled: !service.enabled });
      onRefresh();
    } finally {
      setSaving(false);
    }
  };

  /**
   * Deploy/start a service that has no live container yet. This is the
   * "first-run" path - services.create() saves a DB row but doesn't start
   * a container until the project deploys. If the service is currently
   * disabled, flip it enabled first - otherwise the redeploy pipeline would
   * just skip it.
   */
  const handleDeployStart = async () => {
    setDeploying(true);
    try {
      // Start = provision + launch THIS service on its own (its own container /
      // Oblien workspace), DECOUPLED from the project deploy — no build page, no
      // one-deploy lock, never touches the main app. servicesApi.start
      // provisions-if-missing server-side (and enables the service first).
      const res = await servicesApi.start(projectId, service.id);
      if ((res as any)?.success === false) {
        setDeploying(false);
        showToast((res as any)?.error || t.projectDetail.services.detail.toast.deployFailed, "error", service.name);
        return;
      }
      showToast(interpolate(t.projectDetail.services.detail.toast.serviceStarting, { name: service.name }), "success", t.projectDetail.services.detail.toast.serviceTitle);
      setDeploying(false);
      onRefresh();
    } catch (err) {
      setDeploying(false);
      showToast(
        getApiErrorMessage(err, t.projectDetail.services.detail.toast.deployFailed),
        "error",
        service.name,
      );
    }
  };

  /**
   * PIPELINE services only (compose stack / monorepo sub-app / source-built):
   * rebuild + redeploy ONLY this service and land on the build screen. Image
   * apps don't get this — they Start/Stop.
   */
  const handleRedeployService = async () => {
    if (!activeDeploymentId) {
      showToast(t.projectDetail.services.detail.toast.deployFirstRedeploy, "error", service.name);
      return;
    }
    if (!service.enabled) {
      showToast(t.projectDetail.services.detail.toast.enableBeforeRedeploy, "error", service.name);
      return;
    }
    setRedeploying(true);
    try {
      const res = await deployApi.trigger({ projectId, serviceIds: [service.id] });
      if ((res as any)?.success === false) {
        setRedeploying(false);
        showToast((res as any)?.error || t.projectDetail.services.detail.toast.redeployFailed, "error", service.name);
        return;
      }
      const newId = res?.data?.deployment?.id;
      router.push(newId ? `/build/${newId}` : `/projects/${projectId}/deployments`);
    } catch (err) {
      setRedeploying(false);
      showToast(
        getApiErrorMessage(err, t.projectDetail.services.detail.toast.redeployFailed),
        "error",
        service.name,
      );
    }
  };

  // While `deploying` is true, poll for the container to appear. The redeploy
  // fires-and-forgets on the backend, so watching the service's container
  // state is the only client-side completion signal.
  useEffect(() => {
    if (!deploying) return;
    if (container?.containerId) {
      setDeploying(false);
      return;
    }

    let cancelled = false;
    let elapsed = 0;
    const POLL_INTERVAL = 4_000;
    const POLL_TIMEOUT = 90_000;
    const interval = setInterval(() => {
      if (cancelled) return;
      elapsed += POLL_INTERVAL;
      void onRefresh();
      if (elapsed >= POLL_TIMEOUT) {
        clearInterval(interval);
        setDeploying(false);
        showToast(t.projectDetail.services.detail.toast.stillStarting, "error", service.name);
      }
    }, POLL_INTERVAL);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [deploying, container?.containerId, onRefresh, service.name, showToast]);

  const handleUpdateService = async (data: Partial<ServiceInput>) => {
    const result = await servicesApi.update(projectId, service.id, data);
    if (!result.success) {
      throw new Error(t.projectDetail.services.detail.toast.updateFailed);
    }

    await onRefresh();
    showToast(t.projectDetail.services.detail.toast.serviceUpdated, "success", data.name ?? service.name);
  };

  const handleDeleteService = async () => {
    setDeleting(true);
    try {
      const result = await servicesApi.delete(projectId, service.id);
      if (!result.success) {
        throw new Error(t.projectDetail.services.detail.toast.deleteFailed);
      }
      showToast(t.projectDetail.services.detail.toast.serviceDeleted, "success", service.name);
      setConfirmDelete(false);
      onDeleted?.();
      await onRefresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t.projectDetail.services.detail.toast.deleteFailed, "error");
    } finally {
      setDeleting(false);
    }
  };

  /* ── Render ─────────────────────────────────────────────────── */

  return (
    <div className="space-y-4">
      {/* ── Heading (simple, no card) ──────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-2.5">
          {canSwitchService ? (
            <DropdownMenu
              align="left"
              triggerClassName="group inline-flex items-center gap-1.5 rounded-lg -ms-1.5 px-1.5 py-0.5 transition-colors hover:bg-muted/50"
              trigger={
                <>
                  <span className="text-xl font-semibold tracking-tight text-foreground">{service.name}</span>
                  <ChevronDown className="size-4 text-muted-foreground transition-colors group-hover:text-foreground" />
                </>
              }
              actions={switchableServices.map((s) => ({
                id: s.id,
                label: s.name,
                icon:
                  s.id === service.id ? (
                    <Check className="size-4 text-primary" />
                  ) : (
                    <span className={`size-1.5 rounded-full ${s.enabled ? "bg-success-solid" : "bg-muted-foreground/40"}`} />
                  ),
                disabled: s.id === service.id,
                onClick: () => switchService(s.id),
              }))}
            />
          ) : (
            <h2 className="text-xl font-semibold tracking-tight text-foreground">{service.name}</h2>
          )}
          <StatusBadge status={status} />
        </div>
        {resolvedUrl ? (
          <a
            href={resolvedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground transition-colors hover:text-foreground/70"
          >
            <span className="truncate">{resolvedUrl.replace("https://", "")}</span>
            <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
          </a>
        ) : sourceLabel ? (
          <span className="truncate text-sm text-muted-foreground">{sourceLabel}</span>
        ) : null}
      </div>

      {/* ── Tab strip ──────────────────────────────────────────── */}
      <Tabs
        tabs={SERVICE_TAB_DEFS.map((def) => ({
          ...def,
          label: t.projectDetail.services.detail.tabs[def.key],
          ...(def.key === "backup" ? { hidden: !supportsBackup } : {}),
        }))}
        value={activeTab}
        onChange={changeTab}
      />

      {/* ── Overview ───────────────────────────────────────────── */}
      {activeTab === "overview" && (
        <div className="space-y-4">
          {/* Network */}
          {(container?.containerId || (service.ports && service.ports.length > 0)) && (
            <div className="bg-card rounded-2xl border border-border/50 p-5">
              <SectionHeader title={t.projectDetail.services.detail.network} icon={Network} />
              <div className="space-y-3">
                {/* The stable address sibling services use — service name is the
                    hostname (docker alias / cloud /etc/hosts), NOT the public
                    subdomain. This is what goes in another service's DATABASE_URL. */}
                {internalServiceAddress(service.name, service.ports as string[]) && (
                  <div>
                    <InfoCard
                      label={t.projectDetail.services.detail.internalAddress}
                      value={internalServiceAddress(service.name, service.ports as string[])}
                      mono
                      onCopy={() => copy(internalServiceAddress(service.name, service.ports as string[]), "internal")}
                      copied={copied === "internal"}
                    />
                    <p className="mt-1 px-1 text-[11px] text-muted-foreground">
                      {t.projectDetail.services.detail.internalAddressHint}
                    </p>
                  </div>
                )}
                {service.ports && service.ports.length > 0 && (
                  <InfoCard label={t.projectDetail.services.detail.ports} value={service.ports.join(", ")} onCopy={() => copy(service.ports!.join(", "), "ports")} copied={copied === "ports"} />
                )}
                {container?.hostPort && (
                  <InfoCard label={t.projectDetail.services.detail.hostPort} value={String(container.hostPort)} onCopy={() => copy(String(container.hostPort), "hostPort")} copied={copied === "hostPort"} />
                )}
                {container?.ip && (
                  <div>
                    <InfoCard label={t.projectDetail.services.detail.currentIp} value={container.ip} mono onCopy={() => copy(container.ip!, "ip")} copied={copied === "ip"} />
                    <p className="mt-1 px-1 text-[11px] text-muted-foreground">
                      {t.projectDetail.services.detail.currentIpHint}
                    </p>
                  </div>
                )}
                {container?.containerId && (
                  <InfoCard
                    label={deployTarget === "cloud" ? t.projectDetail.services.detail.workspaceId : t.projectDetail.services.detail.containerId}
                    // Docker ids are 64 chars — the 12-char short id is enough
                    // to `docker exec`. Cloud workspace ids are short/opaque, so
                    // show them in full (you need the whole thing to find it).
                    value={
                      deployTarget === "cloud"
                        ? container.containerId
                        : container.containerId.slice(0, 12)
                    }
                    mono
                    onCopy={() => copy(container.containerId!, "cid")}
                    copied={copied === "cid"}
                  />
                )}
              </div>
            </div>
          )}

          {/* Configuration */}
          {(service.restart || service.command || (service.dependsOn && service.dependsOn.length > 0)) && (
            <div className="bg-card rounded-2xl border border-border/50 p-5">
              <SectionHeader title={t.projectDetail.services.detail.configuration} icon={Settings} />
              <div className="space-y-3">
                {service.restart && <InfoCard label={t.projectDetail.services.detail.restartPolicy} value={service.restart} />}
                {service.command && (
                  <InfoCard label={t.projectDetail.services.detail.command} value={service.command} mono onCopy={() => copy(service.command!, "cmd")} copied={copied === "cmd"} />
                )}
                {service.dependsOn && service.dependsOn.length > 0 && (
                  <InfoCard label={t.projectDetail.services.detail.dependsOn} value={service.dependsOn.join(", ")} />
                )}
              </div>
            </div>
          )}

          {/* Volumes */}
          {service.volumes && service.volumes.length > 0 && (
            <div className="bg-card rounded-2xl border border-border/50 p-5">
              <SectionHeader title={t.projectDetail.services.detail.volumes} icon={HardDrive} />
              <div className="space-y-2">
                {service.volumes.map((vol) => (
                  <div key={vol} className="flex items-center justify-between gap-3 group">
                    <span className="truncate text-xs font-mono text-foreground">{vol}</span>
                    <button
                      onClick={() => copy(vol, `vol-${vol}`)}
                      className="shrink-0 rounded p-1 opacity-0 transition-all hover:bg-muted group-hover:opacity-100"
                    >
                      {copied === `vol-${vol}` ? <Check className="size-3 text-success" /> : <Copy className="size-3 text-muted-foreground" />}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Terminal ───────────────────────────────────────────── */}
      {activeTab === "terminal" && (
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <SectionHeader title={t.projectDetail.services.detail.terminal} icon={Terminal} />
          <div>
            {status === "running" ? (
              <div className="h-[460px]">
                <ServiceTerminal
                  serviceId={service.id}
                  enabled={true}
                  theme={resolvedTheme === "light" ? "light" : "dark"}
                  resumeToken={terminalResumeToken}
                  onResumeTokenChange={persistResumeToken}
                />
              </div>
            ) : (
              <div className="flex min-h-[220px] items-center justify-center rounded-xl border border-border/40 bg-muted/20 text-sm text-muted-foreground">
                {t.projectDetail.services.detail.startShellHint}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Logs ───────────────────────────────────────────────── */}
      {activeTab === "logs" && (
        <div className="min-h-[460px]">
          <TerminalLogs
            projectId={projectId}
            projectName={service.name}
            streamTarget={endpoints.services.logsStream(projectId, service.id)}
            historyTarget={endpoints.services.logs(projectId, service.id)}
            onLogsChange={() => { /* view-only; the panel doesn't need the buffer */ }}
          />
        </div>
      )}

      {/* ── Environment (editable) ─────────────────────────────── */}
      {activeTab === "env" && (
        <div className="space-y-4">
          {/* No extra padding here — EnvironmentVariables (borderless) brings its
              own px-5/py-4, so a wrapper p-6 would double it. */}
          <div className="bg-card rounded-2xl border border-border/50">
            <EnvironmentVariables
              mode="settings"
              envVars={envRows}
              onEnvVarsChange={setEnvRows}
              isEditingMode={true}
              setIsEditingMode={() => { /* always editing in the Env tab */ }}
              showSettingsActions={false}
              borderless
            />
          </div>
          <div className="flex justify-end">
            <button
              onClick={handleSaveEnv}
              disabled={envSaving || !envDirty}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {envSaving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {t.projectDetail.services.detail.saveEnvironment}
            </button>
          </div>
        </div>
      )}

      {/* ── Settings (replaces the old edit modal) ─────────────── */}
      {activeTab === "settings" && (
        <div className="space-y-4">
          {/* Controls — lifecycle + delete live with the service's settings. */}
          <div className="bg-card rounded-2xl border border-border/50 p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2 flex-wrap">
                {container?.containerId ? (
                  <>
                    {status === "running" && (
                      <>
                        <ActionButton icon={Square} label={t.projectDetail.services.detail.stop} loading={actionLoading === "stop"} onClick={() => handleContainerAction("stop")} variant="danger" />
                        <ActionButton icon={RotateCw} label={t.projectDetail.services.detail.restart} loading={actionLoading === "restart"} onClick={() => handleContainerAction("restart")} variant="warning" />
                      </>
                    )}
                    {status !== "running" && (
                      <ActionButton icon={Play} label={t.projectDetail.services.detail.start} loading={actionLoading === "start"} onClick={() => handleContainerAction("start")} variant="success" />
                    )}
                  </>
                ) : (
                  // No workspace/container yet → Start provisions + launches it
                  // inline (its own container / Oblien workspace). No build page,
                  // no redeploy. A source-built service (no image) can't launch
                  // this way — it shows Redeploy (below) instead of Start.
                  canStartWithoutBuild && (
                    <ActionButton
                      icon={Play}
                      label={deploying ? t.projectDetail.services.detail.starting : t.projectDetail.services.detail.start}
                      loading={deploying}
                      onClick={handleDeployStart}
                      variant="success"
                    />
                  )
                )}
                {/* Pipeline services (compose / monorepo / source-built) keep the
                    per-service Redeploy → build page. Image apps never show it. */}
                {usesDeployPipeline && service.enabled && activeDeploymentId && (
                  <ActionButton
                    icon={Rocket}
                    label={redeploying ? t.projectDetail.services.detail.redeploying : t.projectDetail.services.detail.redeploy}
                    loading={redeploying}
                    onClick={handleRedeployService}
                    variant="primary"
                  />
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleToggleEnabled}
                  disabled={saving}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-50 ${
                    service.enabled
                      ? "bg-danger-bg text-danger hover:bg-danger-solid/20 ring-1 ring-danger-border"
                      : "bg-success-bg text-success hover:bg-success-solid/20 ring-1 ring-success-border"
                  }`}
                >
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Power className="size-4" />}
                  {service.enabled ? t.projectDetail.services.detail.disableService : t.projectDetail.services.detail.enableService}
                </button>
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-danger-bg text-danger hover:bg-danger-solid/20 ring-1 ring-danger-border transition-all"
                >
                  <Trash2 className="size-4" />
                  {t.projectDetail.services.detail.delete}
                </button>
              </div>
            </div>
          </div>

          <ServiceSettingsForm service={service} onSubmit={handleUpdateService} />
        </div>
      )}

      {/* ── Backup ─────────────────────────────────────────────── */}
      {activeTab === "backup" && supportsBackup && (
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <SectionHeader
            title={t.projectDetail.services.detail.backup}
            subtitle={
              backupPolicy
                ? `${backupPolicy.payloadKind} · ${backupPolicy.cronExpression ? interpolate(t.projectDetail.services.detail.backupSubtitle.cron, { expr: backupPolicy.cronExpression }) : t.projectDetail.services.detail.backupSubtitle.manualOnly}${backupPolicy.triggerOnPreDeploy ? ` · ${t.projectDetail.services.detail.backupSubtitle.preDeploy}` : ""}${backupPolicy.webhookToken ? ` · ${t.projectDetail.services.detail.backupSubtitle.webhook}` : ""}`
                : t.projectDetail.services.detail.backupSubtitle.none
            }
            icon={DatabaseBackup}
          />
          <div className="space-y-3">
            {activeBackupRunId && <BackupRunCard runId={activeBackupRunId} />}

            <div className="flex items-center gap-2">
              {backupPolicy ? (
                <>
                  <button
                    onClick={() => void handleBackupNow()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    <PlayCircle className="size-3.5" />
                    {t.projectDetail.services.detail.backupNow}
                  </button>
                  <button
                    onClick={() => setBackupEditorOpen(true)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-muted/50 px-3 py-1.5 text-xs font-medium hover:bg-muted"
                  >
                    <Settings className="size-3.5" />
                    {t.projectDetail.services.detail.editPolicy}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setBackupEditorOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-muted/50 px-3 py-1.5 text-xs font-medium hover:bg-muted"
                >
                  <Plus className="size-3.5" />
                  {t.projectDetail.services.detail.createPolicy}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {backupEditorOpen && (
        <PolicyEditor
          projectId={projectId}
          serviceId={service.id}
          serviceName={service.name}
          existing={backupPolicy}
          onClose={() => setBackupEditorOpen(false)}
          onSaved={async () => {
            setBackupEditorOpen(false);
            await reloadBackupPolicy();
          }}
        />
      )}

      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
          onClick={() => setConfirmDelete(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-border/60 bg-card p-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-foreground">{t.projectDetail.services.detail.deleteTitle}</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {interpolate(t.projectDetail.services.detail.deleteBody, { name: service.name })}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="inline-flex h-10 items-center rounded-xl bg-foreground/[0.06] px-4 text-sm font-medium text-foreground transition-colors hover:bg-foreground/[0.1] disabled:opacity-50"
              >
                {t.projectDetail.services.detail.deleteCancel}
              </button>
              <button
                onClick={handleDeleteService}
                disabled={deleting}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-danger-solid px-4 text-sm font-medium text-white transition-colors hover:bg-danger-solid/90 disabled:opacity-50"
              >
                {deleting && <Loader2 className="size-4 animate-spin" />}
                {t.projectDetail.services.detail.deleteConfirm}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Primitives ─────────────────────────────────────────────────────── */

function SectionHeader({ title, subtitle, icon: Icon }: { title: string; subtitle?: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
      </div>
      {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const labels = t.projectDetail.services.detail.status;
  const map: Record<string, { dot: string; badge: string; label: string }> = {
    running: { dot: "bg-success-solid", badge: "bg-success-bg text-success", label: labels.running },
    stopped: { dot: "bg-muted-foreground/30", badge: "bg-muted/60 text-muted-foreground/70", label: labels.stopped },
    disabled: { dot: "bg-muted-foreground/20", badge: "bg-muted/40 text-muted-foreground/50", label: labels.disabled },
    failed: { dot: "bg-danger-solid", badge: "bg-danger-bg text-danger", label: labels.failed },
    starting: { dot: "bg-warning-solid", badge: "bg-warning-bg text-warning", label: labels.starting },
  };
  const s = map[status] ?? map.stopped;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold ${s.badge}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function ActionButton({ icon: Icon, label, loading, onClick, variant }: {
  icon: React.ComponentType<{ className?: string }>; label: string; loading: boolean; onClick: () => void; variant: "success" | "danger" | "warning" | "primary";
}) {
  const colors = {
    success: "bg-success-bg text-success hover:bg-success-solid/20 ring-1 ring-success-border",
    danger: "bg-danger-bg text-danger hover:bg-danger-solid/20 ring-1 ring-danger-border",
    warning: "bg-warning-bg text-warning hover:bg-warning-solid/20 ring-1 ring-warning-border",
    primary: "bg-primary/10 text-primary hover:bg-primary/20 ring-1 ring-primary/15",
  };
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick(); }} disabled={loading}
      className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-50 ${colors[variant]}`}>
      {loading ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
      {label}
    </button>
  );
}

function InfoCard({ label, value, mono, onCopy, copied }: {
  icon?: React.ComponentType<{ className?: string }>; label: string; value: string; mono?: boolean; onCopy?: () => void; copied?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 group">
      <p className="shrink-0 text-[13px] text-muted-foreground">{label}</p>
      <div className="flex min-w-0 items-center gap-1.5">
        <p className={`truncate text-[13px] font-medium text-foreground ${mono ? "font-mono" : ""}`}>{value}</p>
        {onCopy && (
          <button
            onClick={onCopy}
            className="shrink-0 rounded p-1 opacity-0 transition-all hover:bg-muted group-hover:opacity-100"
          >
            {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3 text-muted-foreground" />}
          </button>
        )}
      </div>
    </div>
  );
}
