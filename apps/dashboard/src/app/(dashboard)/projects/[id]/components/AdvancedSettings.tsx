import React, { useState } from "react";
import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  Cloud,
  Copy,
  HardDrive,
  Hammer,
  Loader2,
  Network,
  Package,
  Pause,
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
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { projectsApi } from "@/lib/api";
import type { RouteStrategy } from "@/lib/api/settings";

interface Props {
  onDeleteProject: (deleteApp?: boolean, wipeVolumes?: boolean, recordOnly?: boolean) => void;
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
}: {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  iconTone: keyof typeof ICON_TONES;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      <div className="flex items-start gap-3 border-b border-border/40 px-5 py-4">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${ICON_TONES[iconTone]}`}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="space-y-4 px-5 py-4">{children}</div>
    </div>
  );
}

export const AdvancedSettings = ({ onDeleteProject }: Props) => {
  const { showToast } = useToast();
  const { t } = useI18n();
  const { projectData } = useProjectSettings();
  const [isProjectActive, setIsProjectActive] = useState(projectData?.active ?? true);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const [loading, setLoading] = useState({
    disableProject: false,
    clearInstallCache: false,
    clearBuildCache: false,
  });

  const handleDisableProject = async () => {
    if (loading.disableProject) return;
    setLoading((s) => ({ ...s, disableProject: true }));
    const response = await projectsApi.toggle(projectData.id, !isProjectActive);
    if (response.success) {
      setIsProjectActive(!isProjectActive);
    } else {
      showToast(response.message, "error", t.projectSettings.advanced.toast.toggleFailed);
    }
    setLoading((s) => ({ ...s, disableProject: false }));
  };

  const handleClearInstallCache = async () => {
    if (loading.clearInstallCache) return;
    setLoading((s) => ({ ...s, clearInstallCache: true }));
    const response = await projectsApi.clearCache(projectData.id);
    if (!response.success) {
      showToast(response.message, "error", t.projectSettings.advanced.toast.clearInstallFailed);
    }
    setLoading((s) => ({ ...s, clearInstallCache: false }));
  };

  const handleClearBuildCache = async () => {
    if (loading.clearBuildCache) return;
    setLoading((s) => ({ ...s, clearBuildCache: true }));
    const response = await projectsApi.clearBuild(projectData.id);
    if (!response.success) {
      showToast(response.message, "error", t.projectSettings.advanced.toast.clearBuildFailed);
    }
    setLoading((s) => ({ ...s, clearBuildCache: false }));
  };

  return (
    <div className="space-y-5">
      {/* Project Info */}
      <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
        <div className="flex items-start gap-3 border-b border-border/40 px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Settings2 className="size-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold text-foreground">{t.projectSettings.advanced.projectInfo.title}</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{t.projectSettings.advanced.projectInfo.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-6 px-5 py-4">
          <MetricRow label={t.projectSettings.advanced.metric.status} value={isProjectActive ? t.projectSettings.advanced.statusActive : t.projectSettings.advanced.statusDisabled} />
          <MetricRow label={t.projectSettings.advanced.metric.project} value={projectData?.name || "-"} />
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
          <div className="flex items-center justify-between rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
            <div className="flex items-center gap-3">
              <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${isProjectActive ? "bg-success-bg" : "bg-warning-bg"}`}>
                {isProjectActive ? (
                  <Pause className="size-4 text-success" />
                ) : (
                  <Play className="size-4 text-warning" />
                )}
              </div>
              <div>
                <p className="text-[13px] font-medium text-foreground">
                  {isProjectActive ? t.projectSettings.advanced.projectStatus.active : t.projectSettings.advanced.projectStatus.disabled}
                </p>
                <p className="text-[12px] text-muted-foreground">
                  {isProjectActive ? t.projectSettings.advanced.projectStatus.liveAccessible : t.projectSettings.advanced.projectStatus.pausedInaccessible}
                </p>
              </div>
            </div>
            <button
              onClick={handleDisableProject}
              disabled={loading.disableProject}
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

        {/* Routing (edge → app upstream) — self-hosted only; cloud handles its
            own ingress. Advanced opt-in; loopback-port is the safe default. */}
        {projectData?.deployTarget !== "cloud" && (
          <SectionCard
            title={t.projectSettings.advanced.routing.title}
            description={t.projectSettings.advanced.routing.description}
            icon={Waypoints}
            iconTone="primary"
          >
            <RoutingStrategyCard
              projectId={projectData.id}
              initial={(projectData?.routeStrategy as RouteStrategy) ?? "auto"}
            />
          </SectionCard>
        )}

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

      <DeletionModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={onDeleteProject}
        projectName={projectData?.name || projectData?.domain}
        projectId={projectData?.id}
        selfHosted={!projectData?.cloudWorkspaceId}
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

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="max-w-[180px] truncate text-end text-[13px] font-medium text-foreground">{value}</span>
    </div>
  );
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

