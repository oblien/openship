"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { DeploymentMenu } from "./DeploymentMenu";
import { CommitDetailsModal } from "./CommitDetailsModal";
import type { Deployment } from "../types";
import { formatDistanceToNow, formatBuildTime, getStatusConfig } from "../utils";
import { GitBranch, Clock, ExternalLink, MoreVertical, Archive, Pin, Activity } from "lucide-react";
import { getFrameworkConfig } from "@/components/import-project/Frameworks";
import { AppLogo } from "@/components/AppLogo";
import { useI18n, interpolate } from "@/components/i18n-provider";

type ServiceStatusLabels = {
  deployed: string;
  failed: string;
  cancelled: string;
  skipped: string;
  building: string;
  deploying: string;
  running: string;
  removedOnHost: string;
  verifying: string;
  pending: string;
};

interface DeploymentCardProps {
  deployment: Deployment;
  onStatusChange?: () => void;
  /** Catalog-app projects render the app's brand logo instead of the
   *  stack/framework glyph (an app deploy is a docker-compose stack, but the
   *  user thinks of it as "Convex", not "Docker Compose"). */
  appTemplateId?: string;
}

/**
 * Pill colors + label for a per-service deploy status. Kept inline here
 * because the only consumer is the deployment card's service-fan-out
 * row; promoting to utils would invite scope creep.
 */
function getServiceStatusChipConfig(
  status: NonNullable<Deployment["serviceDeployments"]>[number]["status"],
  labels: ServiceStatusLabels,
) {
  switch (status) {
    case "success":
      return {
        label: labels.deployed,
        bgClass: "bg-success-bg",
        textClass: "text-success",
        dotClass: "bg-success-solid",
      };
    case "failure":
      return {
        label: labels.failed,
        bgClass: "bg-danger-bg",
        textClass: "text-danger",
        dotClass: "bg-danger-solid",
      };
    case "cancelled":
      return {
        label: labels.cancelled,
        bgClass: "bg-muted/60",
        textClass: "text-muted-foreground",
        dotClass: "bg-muted-foreground",
      };
    case "skipped":
      return {
        label: labels.skipped,
        bgClass: "bg-muted/40",
        textClass: "text-muted-foreground",
        dotClass: "bg-muted-foreground",
      };
    case "building":
    case "deploying":
    case "in_progress":
      return {
        label:
          status === "building"
            ? labels.building
            : status === "deploying"
              ? labels.deploying
              : labels.running,
        bgClass: "bg-info-bg",
        textClass: "text-info",
        dotClass: "bg-info-solid",
      };
    case "missing":
      // Drift: the container was removed on the host out-of-band.
      return {
        label: labels.removedOnHost,
        bgClass: "bg-warning-bg",
        textClass: "text-warning",
        dotClass: "bg-warning-solid",
      };
    case "indeterminate":
      // Started but unverified — connection dropped mid-deploy.
      return {
        label: labels.verifying,
        bgClass: "bg-warning-bg",
        textClass: "text-warning",
        dotClass: "bg-warning-solid",
      };
    case "pending":
    default:
      return {
        label: labels.pending,
        bgClass: "bg-warning-bg",
        textClass: "text-warning",
        dotClass: "bg-warning-solid",
      };
  }
}

export const DeploymentCard: React.FC<DeploymentCardProps> = ({
  deployment,
  onStatusChange,
  appTemplateId,
}) => {
  const { t } = useI18n();
  const router = useRouter();
  const [isCommitModalOpen, setIsCommitModalOpen] = useState(false);
  const statusConfig = getStatusConfig(deployment.status);
  const frameworkConfig = getFrameworkConfig(deployment.framework);

  const statusLabelMap: Record<string, string> = {
    success: t.deployments.status.deployed,
    failed: t.deployments.status.failed,
    canceled: t.deployments.status.canceled,
    cancelled: t.deployments.status.canceled,
    building: t.deployments.status.building,
    deploying: t.deployments.status.deploying,
    partial_failure: t.deployments.status.partial,
    rejected: t.deployments.status.rejected,
    reconciling: t.deployments.status.verifying,
  };
  const statusLabel = statusLabelMap[deployment.status] ?? t.deployments.status.pending;

  const hasCommitData = deployment.commit?.hash && deployment.commit.hash !== "N/A";
  const hasCommitMessage =
    deployment.commit?.message && deployment.commit.message !== "Manual deployment";

  return (
    <div
      className="group relative flex cursor-pointer items-center gap-4 px-4 py-4 transition-colors hover:bg-muted/25"
      onClick={() => router.push(`/build/${deployment.id}`)}
    >
      {/* App logo (catalog apps) → else framework icon → else initials */}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted/45 transition-colors group-hover:bg-muted/65">
        {appTemplateId ? (
          <AppLogo appId={appTemplateId} className="size-5 object-contain" />
        ) : frameworkConfig.icon ? (
          frameworkConfig.icon("hsl(var(--foreground))")
        ) : (
          <span className="text-xs font-mono font-bold text-muted-foreground">
            {(deployment.framework || "?").slice(0, 2).toUpperCase()}
          </span>
        )}
      </div>

      {/* Main info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
          <p className="text-sm font-semibold text-foreground truncate">
            {deployment.projectName || t.deployments.card.unknownProject}
          </p>
          {deployment.version != null && (
            <span
              className="shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground"
              title={interpolate(t.deployments.card.versionTitle, {
                version: String(deployment.version),
              })}
            >
              v{deployment.version}
            </span>
          )}
          <span
            className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusConfig.bgColor}`}
            style={{ color: statusConfig.color }}
          >
            {statusLabel}
          </span>
          {/* Rollback-state chips. Surfaced from the orchestrator-aware
              listing endpoint. Order: Active > Pinned > Snapshotted so
              the highest-signal one sits closest to the title. */}
          {deployment.isActive && (
            <span
              className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-success"
              title={t.deployments.card.activeTitle}
            >
              <Activity className="size-2.5" />
              {t.deployments.card.active}
            </span>
          )}
          {deployment.pinned && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning-bg px-2 py-0.5 text-[11px] font-medium text-warning"
              title={t.deployments.card.pinnedTitle}
            >
              <Pin className="size-2.5" />
              {t.deployments.card.pinned}
            </span>
          )}
          {!deployment.pinned && deployment.artifactRetainedAt && !deployment.isActive && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
              title={t.deployments.card.snapshottedTitle}
            >
              <Archive className="size-2.5" />
              {t.deployments.card.snapshotted}
            </span>
          )}
        </div>

        {/* Per-service status badges. Surfaced from the
            service_deployment fan-out when the orchestrator-aware
            listing endpoint returns rows for this deployment. */}
        {deployment.serviceDeployments && deployment.serviceDeployments.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {deployment.serviceDeployments.map((sd) => {
              const cfg = getServiceStatusChipConfig(sd.status, t.deployments.serviceStatus);
              return (
                <span
                  key={sd.id}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${cfg.bgClass} ${cfg.textClass}`}
                  title={
                    sd.reason
                      ? interpolate(t.deployments.card.serviceTitleReason, {
                          name: sd.serviceName,
                          label: cfg.label,
                          reason: sd.reason,
                        })
                      : interpolate(t.deployments.card.serviceTitle, {
                          name: sd.serviceName,
                          label: cfg.label,
                        })
                  }
                >
                  <span className={`size-1.5 rounded-full ${cfg.dotClass}`} />
                  {sd.serviceName}
                  <span className="opacity-60">·</span>
                  {cfg.label}
                </span>
              );
            })}
          </div>
        )}
        <div className="flex items-center gap-2 mt-0.5">
          <p className="max-w-[320px] truncate text-xs text-muted-foreground">
            {hasCommitMessage ? deployment.commit.message : t.deployments.card.manualDeploy}
          </p>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-xs text-muted-foreground shrink-0">
            {formatDistanceToNow(new Date(deployment.createdAt), t.deployments.time)}
          </span>
          {deployment.buildTime ? (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-xs text-muted-foreground shrink-0 flex items-center gap-1">
                <Clock className="size-3" />
                {formatBuildTime(deployment.buildTime)}
              </span>
            </>
          ) : null}
          {deployment.branch && (
            <>
              <span className="text-muted-foreground/40 hidden sm:inline">·</span>
              <span className="text-xs text-muted-foreground shrink-0 items-center gap-1 hidden sm:flex">
                <GitBranch className="size-3" />
                {deployment.branch}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Right side - commit hash + actions */}
      <div className="flex items-center gap-2 shrink-0">
        {hasCommitData && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (deployment.owner && deployment.repo) {
                window.open(
                  `https://github.com/${deployment.owner}/${deployment.repo}/commit/${deployment.commit.fullHash || deployment.commit.hash}`,
                  "_blank",
                );
              } else {
                setIsCommitModalOpen(true);
              }
            }}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            {deployment.commit.hash.slice(0, 7)}
            {deployment.owner && deployment.repo && <ExternalLink className="size-3" />}
          </button>
        )}

        <DeploymentMenu
          deployment={deployment}
          triggerClassName="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground/50 transition-colors hover:bg-muted/50 hover:text-foreground"
          onStatusChange={onStatusChange}
        />
      </div>

      <CommitDetailsModal
        deployment={deployment}
        isOpen={isCommitModalOpen}
        onClose={() => setIsCommitModalOpen(false)}
      />
    </div>
  );
};
