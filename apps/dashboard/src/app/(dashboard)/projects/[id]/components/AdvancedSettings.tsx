import React, { useState } from "react";
import {
  AlertTriangle,
  ArrowRightLeft,
  Cloud,
  Copy,
  HardDrive,
  Hammer,
  Loader2,
  Package,
  Pause,
  Play,
  Server,
  Settings2,
  Trash2,
} from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { DeletionModal } from "./DeletionModal";
import { useToast } from "@/context/ToastContext";
import { projectsApi } from "@/lib/api";

interface Props {
  onDeleteProject: () => void;
}

const ICON_TONES = {
  primary: "bg-primary/10 text-primary",
  amber: "bg-amber-500/10 text-amber-500",
  red: "bg-red-500/10 text-red-500",
} as const;

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
      showToast(response.message, "error", "Failed to toggle project");
    }
    setLoading((s) => ({ ...s, disableProject: false }));
  };

  const handleClearInstallCache = async () => {
    if (loading.clearInstallCache) return;
    setLoading((s) => ({ ...s, clearInstallCache: true }));
    const response = await projectsApi.clearCache(projectData.id);
    if (!response.success) {
      showToast(response.message, "error", "Failed to clear install cache");
    }
    setLoading((s) => ({ ...s, clearInstallCache: false }));
  };

  const handleClearBuildCache = async () => {
    if (loading.clearBuildCache) return;
    setLoading((s) => ({ ...s, clearBuildCache: true }));
    const response = await projectsApi.clearBuild(projectData.id);
    if (!response.success) {
      showToast(response.message, "error", "Failed to clear build cache");
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
            <h3 className="text-[14px] font-semibold text-foreground">Project Info</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">Current configuration summary</p>
          </div>
        </div>
        <div className="flex items-center gap-6 px-5 py-4">
          <MetricRow label="Status" value={isProjectActive ? "Active" : "Disabled"} />
          <MetricRow label="Project" value={projectData?.name || "—"} />
          {projectData?.deployTarget && (
            <MetricRow
              label="Hosted On"
              value={
                projectData.deployTarget === "cloud"
                  ? "Openship Cloud"
                  : projectData.deployTarget === "server"
                    ? projectData.serverName || "Server"
                    : "Local"
              }
            />
          )}
        </div>
      </div>

      {/* Project Status */}
      <SectionCard
        title="Project Status"
        description="Control whether the project is live or paused"
        icon={Settings2}
        iconTone="primary"
      >
          <div className="flex items-center justify-between rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
            <div className="flex items-center gap-3">
              <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${isProjectActive ? "bg-emerald-500/10" : "bg-amber-500/10"}`}>
                {isProjectActive ? (
                  <Pause className="size-4 text-emerald-500" />
                ) : (
                  <Play className="size-4 text-amber-500" />
                )}
              </div>
              <div>
                <p className="text-[13px] font-medium text-foreground">
                  {isProjectActive ? "Project Active" : "Project Disabled"}
                </p>
                <p className="text-[12px] text-muted-foreground">
                  {isProjectActive ? "Live and accessible" : "Paused and not accessible"}
                </p>
              </div>
            </div>
            <button
              onClick={handleDisableProject}
              disabled={loading.disableProject}
              className={`inline-flex h-9 items-center gap-1.5 rounded-xl px-4 text-[13px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                isProjectActive
                  ? "bg-amber-500/10 text-amber-600 hover:bg-amber-500/20"
                  : "bg-primary/10 text-primary hover:bg-primary/20"
              }`}
            >
              {loading.disableProject ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : isProjectActive ? (
                "Disable"
              ) : (
                "Enable"
              )}
            </button>
          </div>
        </SectionCard>

        {/* Cache Management */}
        <SectionCard
          title="Cache"
          description="Clear cached build artifacts and dependency installs"
          icon={Package}
          iconTone="amber"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              onClick={handleClearInstallCache}
              disabled={loading.clearInstallCache}
              className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-left transition-colors hover:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <Package className="size-4 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground">Clear Install Cache</p>
                <p className="text-[12px] text-muted-foreground">Remove cached node_modules</p>
              </div>
              {loading.clearInstallCache && <Loader2 className="ml-auto size-4 animate-spin text-muted-foreground" />}
            </button>

            <button
              onClick={handleClearBuildCache}
              disabled={loading.clearBuildCache}
              className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-left transition-colors hover:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <Hammer className="size-4 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground">Clear Build Cache</p>
                <p className="text-[12px] text-muted-foreground">Remove cached build output</p>
              </div>
              {loading.clearBuildCache && <Loader2 className="ml-auto size-4 animate-spin text-muted-foreground" />}
            </button>
          </div>
        </SectionCard>

        {/* Transfer & Clone */}
        <SectionCard
          title="Transfer & Clone"
          description="Move or duplicate this project to a different environment"
          icon={ArrowRightLeft}
          iconTone="primary"
        >
          <TransferOptions
            currentTarget={projectData?.deployTarget}
            currentServer={projectData?.serverName}
          />
        </SectionCard>

        {/* Danger Zone */}
        <div className="overflow-hidden rounded-2xl border border-red-500/20 bg-card">
          <div className="flex items-start gap-3 border-b border-red-500/15 px-5 py-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-500/10">
              <AlertTriangle className="size-4 text-red-500" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-[14px] font-semibold text-red-600 dark:text-red-400">Danger Zone</h3>
              <p className="mt-0.5 text-[12px] text-muted-foreground">Irreversible actions for this project</p>
            </div>
          </div>
          <div className="px-5 py-4">
            <p className="text-[13px] text-muted-foreground leading-relaxed">
              Deleting this project will permanently remove all deployments, custom domains, environment variables, and analytics data.
            </p>
            <button
              onClick={() => setShowDeleteModal(true)}
              className="mt-4 inline-flex h-9 items-center gap-2 rounded-xl bg-red-600 px-4 text-[13px] font-medium text-white transition-colors hover:bg-red-700"
            >
              <Trash2 className="size-3.5" />
              Delete Project
            </button>
          </div>
        </div>

      <DeletionModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={onDeleteProject}
        projectName={projectData?.name || projectData?.domain}
      />
    </div>
  );
};

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="max-w-[180px] truncate text-right text-[13px] font-medium text-foreground">{value}</span>
    </div>
  );
}

/* ── Transfer & Clone ─────────────────────────────────────────────── */

const TARGET_META: Record<string, { label: string; icon: React.ReactNode }> = {
  local: { label: "Local Machine", icon: <HardDrive className="size-4" /> },
  server: { label: "Self-Hosted Server", icon: <Server className="size-4" /> },
  cloud: { label: "Openship Cloud", icon: <Cloud className="size-4" /> },
};

function TransferOptions({
  currentTarget,
  currentServer,
}: {
  currentTarget?: string | null;
  currentServer?: string | null;
}) {
  const current = TARGET_META[currentTarget ?? ""];

  // Build transfer options — everything except the current target
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
            <p className="text-[13px] font-medium text-foreground">{current.label}</p>
            {currentTarget === "server" && currentServer && (
              <p className="text-[12px] text-muted-foreground">{currentServer}</p>
            )}
          </div>
          <span className="inline-flex items-center gap-1 shrink-0 text-[12px] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Current
          </span>
        </div>
      )}

      {/* Transfer + Clone options */}
      <div className="grid gap-2 sm:grid-cols-3">
        {transferTargets.map(([key, meta]) => (
          <button
            key={key}
            className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-left transition-colors hover:border-border hover:bg-muted/40"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              {meta.icon}
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-foreground">Transfer</p>
              <p className="text-[12px] text-muted-foreground">{meta.label}</p>
            </div>
          </button>
        ))}

        <button
          className="flex items-center gap-3 rounded-xl border border-dashed border-border/50 bg-muted/10 px-4 py-3 text-left transition-colors hover:border-border hover:bg-muted/30"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Copy className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground">Clone</p>
            <p className="text-[12px] text-muted-foreground">Another server</p>
          </div>
        </button>
      </div>
    </div>
  );
}


