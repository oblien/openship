"use client";

import React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Box,
  ChevronDown,
  GitCommitHorizontal,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldCheck,
  Terminal,
  Upload,
} from "lucide-react";
import DropdownMenu from "@/components/ui/DropdownMenu";
import { useModal } from "@/context/ModalContext";
import { useToast } from "@/context/ToastContext";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { deployApi } from "@/lib/api";
import { openTriggeredBuild } from "@/lib/deploy-nav";
import { servicesApi } from "@/lib/api/services";
import { projectsApi } from "@/lib/api/projects";

type LiveState = Awaited<ReturnType<typeof projectsApi.getLiveState>>["data"];

function ageLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 90) return `${sec} second${sec === 1 ? "" : "s"}`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min} minute${min === 1 ? "" : "s"}`;
  const hr = Math.round(min / 60);
  if (hr < 36) return `${hr} hour${hr === 1 ? "" : "s"}`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? "" : "s"}`;
}

function strategyLabel(strategy: "prebuilt" | "server" | "upload" | undefined): string {
  if (strategy === "server") return "Prepared on server";
  if (strategy === "prebuilt") return "Prebuilt in Git";
  if (strategy === "upload") return "Local artifact";
  return "";
}

async function sha256FileBrowser(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function httpsLabel(https: LiveState["public"]["https"] | undefined): string {
  if (https === "passed") return "HTTPS passed";
  if (https === "failed") return "HTTPS failed";
  if (https === "skipped") return "No public hostname";
  return "HTTPS unchecked";
}

function digestShort(digest: string | null | undefined, imageRef: string | null | undefined): string {
  const raw = digest || imageRef || "";
  if (!raw) return "—";
  const sha = raw.includes("sha256:") ? raw.slice(raw.indexOf("sha256:")) : raw;
  return sha.length > 18 ? `${sha.slice(0, 17)}…` : sha;
}

function previewCopy(action: string, fromSha: string | null, toLabel: string): string[] {
  if (action === "rebuild_runtime") {
    return ["Runtime rebuild", "Code pointer stays until the new image is live", "Expected interruption: container replace"];
  }
  if (action === "refresh_config") {
    return ["Configuration refresh", "Runtime unchanged", "Expected interruption: container recreate from current image"];
  }
  return [
    `Code-only release`,
    fromSha ? `${fromSha.slice(0, 7)} → ${toLabel}` : `Deploy ${toLabel}`,
    "Runtime unchanged",
    "Expected interruption: service reload",
  ];
}

export function LiveReleaseHeader({
  onRebuildRuntime,
  rebuilding,
}: {
  onRebuildRuntime: () => void;
  rebuilding: boolean;
}) {
  const { id, projectData, selectedDomain, domain, servicesData, setActiveTab } = useProjectSettings();
  const router = useRouter();
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const [live, setLive] = React.useState<LiveState | null>(null);
  const [deploying, setDeploying] = React.useState(false);
  const uploadInputRef = React.useRef<HTMLInputElement>(null);
  const uploadMode =
    (projectData?.mountedRelease as { buildMode?: string } | null)?.buildMode === "upload";

  const hostname =
    live?.public.hostname || selectedDomain || domain || projectData?.name || "This project";

  const refreshLive = React.useCallback(() => {
    if (!id) return;
    void projectsApi
      .getLiveState(id)
      .then((res) => setLive(res.data))
      .catch(() => setLive(null));
  }, [id]);

  React.useEffect(() => {
    refreshLive();
  }, [
    refreshLive,
    projectData?.activeDeploymentId,
    projectData?.activeReleaseDeploymentId,
  ]);

  const startCodeDeploy = async (commitSha?: string) => {
    if (!id || deploying) return;
    setDeploying(true);
    try {
      const response = await deployApi.mountedRelease(id, commitSha ? { commitSha } : undefined);
      openTriggeredBuild(router, response, id);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not start the code release.", "error");
      setDeploying(false);
    }
  };

  const handleDeployLatest = async () => {
    if (!id || deploying) return;
    try {
      const plan = await deployApi.planRelease(id, { changedPaths: null });
      const lines = previewCopy(plan.data.action, live?.code?.sha ?? null, "latest");
      let modalId = "";
      modalId = showModal({
        title: "Deploy latest",
        customContent: (
          <div className="space-y-4 p-1">
            <div className="space-y-1 text-sm text-foreground">
              {lines.map((line) => (
                <p key={line} className={line === lines[0] ? "font-medium" : "text-muted-foreground"}>
                  {line}
                </p>
              ))}
              <p className="pt-2 text-[12px] text-muted-foreground">{plan.data.reason}</p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-muted/40"
                onClick={() => hideModal(modalId)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90"
                onClick={() => {
                  hideModal(modalId);
                  void startCodeDeploy();
                }}
              >
                Deploy
              </button>
            </div>
          </div>
        ),
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not plan the release.", "error");
    }
  };

  const handleSpecificCommit = () => {
    const sha = window.prompt("Commit SHA to deploy");
    if (!sha?.trim()) return;
    void startCodeDeploy(sha.trim());
  };

  const handleUploadArtifact = () => {
    uploadInputRef.current?.click();
  };

  const handleArtifactPicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !id || deploying) return;
    setDeploying(true);
    try {
      const sha256 = await sha256FileBrowser(file);
      const response = await deployApi.uploadArtifact(id, file, { sha256 });
      openTriggeredBuild(router, response, id);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not upload the artifact.", "error");
      setDeploying(false);
    }
  };

  const handleRollback = async () => {
    if (!id) return;
    try {
      const result = await deployApi.rollbackLatest(id);
      const operationId = result.operationId ?? (result as { data?: { operationId?: string } }).data?.operationId;
      if (operationId && operationId !== live?.code?.deploymentId) router.push(`/build/${operationId}`);
      else showToast("Rolled back to the previous code release.", "success");
      refreshLive();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Rollback failed.", "error");
    }
  };

  const handleRestart = async () => {
    const serviceId =
      (projectData?.mountedRelease as { serviceId?: string } | null)?.serviceId ||
      servicesData.services[0]?.id;
    if (!id || !serviceId) {
      showToast("No service to restart.", "error");
      return;
    }
    try {
      await servicesApi.restart(id, serviceId);
      showToast("Service restart requested.", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Restart failed.", "error");
    }
  };

  const https = live?.public.https;
  const healthy = https === "passed" || https === "skipped" || https === "unchecked";

  return (
    <section className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      <div className="flex flex-col gap-4 border-b border-border/40 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">{hostname}</h3>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                healthy ? "bg-success-bg text-success" : "bg-danger-bg text-danger"
              }`}
            >
              {https === "failed" ? "Unhealthy" : "Healthy"}
            </span>
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {httpsLabel(https)}
            {live?.server?.name ? ` · ${live.server.name}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => (uploadMode ? handleUploadArtifact() : void handleDeployLatest())}
            disabled={deploying || rebuilding}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deploying ? (
              <RefreshCw className="size-4 animate-spin" />
            ) : uploadMode ? (
              <Upload className="size-4" />
            ) : (
              <ArrowRight className="size-4" />
            )}
            {deploying ? "Deploying…" : uploadMode ? "Upload artifact" : "Deploy latest"}
          </button>
          <input
            ref={uploadInputRef}
            type="file"
            accept=".tar.gz,.tgz,.tar.zst,.tar,.gz"
            className="hidden"
            onChange={(event) => void handleArtifactPicked(event)}
          />
          <DropdownMenu
            align="right"
            triggerLabel="More release actions"
            triggerClassName="inline-flex h-10 items-center justify-center gap-1 rounded-xl border border-border/60 bg-muted/20 px-3 text-sm font-medium text-foreground hover:bg-muted/50"
            trigger={
              <>
                More <ChevronDown className="size-3.5" />
              </>
            }
            actions={[
              ...(uploadMode
                ? [
                    {
                      id: "upload",
                      label: "Upload artifact",
                      icon: <Upload className="size-4" />,
                      onClick: handleUploadArtifact,
                    },
                  ]
                : [
                    {
                      id: "commit",
                      label: "Deploy specific commit",
                      icon: <GitCommitHorizontal className="size-4" />,
                      onClick: handleSpecificCommit,
                    },
                  ]),
              {
                id: "rebuild",
                label: rebuilding ? "Rebuilding…" : "Rebuild runtime",
                icon: <Box className="size-4" />,
                onClick: onRebuildRuntime,
                disabled: rebuilding || deploying,
              },
              {
                id: "restart",
                label: "Restart service",
                icon: <RefreshCw className="size-4" />,
                onClick: () => void handleRestart(),
              },
              {
                id: "rollback",
                label: "Roll back",
                icon: <RotateCcw className="size-4" />,
                onClick: () => void handleRollback(),
              },
              {
                id: "terminal",
                label: "Open terminal",
                icon: <Terminal className="size-4" />,
                onClick: () => setActiveTab("logs"),
              },
            ]}
          />
        </div>
      </div>
      <div className="grid gap-px bg-border/40 sm:grid-cols-3">
        <div className="bg-card px-5 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Code</p>
          <p className="mt-1 font-mono text-[13px] font-medium text-foreground">
            {live?.code?.sha?.slice(0, 7) ?? "Not deployed"}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {[strategyLabel(live?.code?.strategy), ageLabel(live?.code?.activatedAt)].filter(Boolean).join(" · ") ||
              "Rebuild runtime once, then deploy code."}
          </p>
        </div>
        <div className="bg-card px-5 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Runtime</p>
          <p className="mt-1 font-mono text-[13px] font-medium text-foreground">
            {digestShort(live?.runtime.digest, live?.runtime.imageRef)}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {live?.runtime.builtAt ? `built ${new Date(live.runtime.builtAt).toLocaleDateString()}` : "Current container"}
          </p>
        </div>
        <div className="bg-card px-5 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Server</p>
          <p className="mt-1 flex items-center gap-1.5 text-[13px] font-medium text-foreground">
            <Server className="size-3.5 text-muted-foreground" />
            {live?.server?.name ?? "—"}
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            {httpsLabel(https)}
          </p>
        </div>
      </div>
    </section>
  );
}
