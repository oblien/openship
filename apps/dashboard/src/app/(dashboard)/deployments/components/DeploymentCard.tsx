"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { DeploymentMenu } from "./DeploymentMenu";
import { CommitDetailsModal } from "./CommitDetailsModal";
import type { Deployment } from "../types";
import { formatDistanceToNow, formatBuildTime, getStatusConfig } from "../utils";
import { GitBranch, Clock, ExternalLink, MoreVertical } from "lucide-react";
import { getFrameworkConfig } from "@/components/import-project/Frameworks";

interface DeploymentCardProps {
  deployment: Deployment;
  onStatusChange?: () => void;
}

export const DeploymentCard: React.FC<DeploymentCardProps> = ({ deployment, onStatusChange }) => {
  const router = useRouter();
  const [isCommitModalOpen, setIsCommitModalOpen] = useState(false);
  const statusConfig = getStatusConfig(deployment.status);
  const frameworkConfig = getFrameworkConfig(deployment.framework);

  const hasCommitData = deployment.commit?.hash && deployment.commit.hash !== "N/A";
  const hasCommitMessage = deployment.commit?.message && deployment.commit.message !== "Manual deployment";

  return (
    <div
      className="group flex cursor-pointer items-center gap-4 px-4 py-4 transition-colors hover:bg-muted/25"
      onClick={() => router.push(`/build/${deployment.id}`)}
    >
      {/* Framework icon */}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/45 transition-colors group-hover:bg-muted/65">
        {frameworkConfig.icon ? (
          frameworkConfig.icon("hsl(var(--foreground))")
        ) : (
          <span className="text-xs font-mono font-bold text-muted-foreground">
            {(deployment.framework || "?").slice(0, 2).toUpperCase()}
          </span>
        )}
      </div>

      {/* Main info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <p className="text-sm font-semibold text-foreground truncate">
            {deployment.projectName || "Unknown Project"}
          </p>
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${statusConfig.bgColor}`}
            style={{ color: statusConfig.color }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: statusConfig.color }} />
            {statusConfig.label}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <p className="max-w-[320px] truncate text-xs text-muted-foreground">
            {hasCommitMessage ? deployment.commit.message : "Manual deploy"}
          </p>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-xs text-muted-foreground shrink-0">
            {formatDistanceToNow(new Date(deployment.createdAt))}
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

      {/* Right side — commit hash + actions */}
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
