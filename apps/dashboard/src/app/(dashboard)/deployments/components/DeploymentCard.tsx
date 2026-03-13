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
      className="px-4 py-3.5 flex items-center gap-4 hover:bg-muted/40 transition-colors cursor-pointer group"
      onClick={() => router.push(`/build/${deployment.id}`)}
    >
      {/* Framework icon */}
      <div className="w-10 h-10 rounded-xl bg-muted/60 flex items-center justify-center shrink-0 group-hover:bg-muted transition-colors">
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
          <p className="text-sm font-medium text-foreground truncate">
            {deployment.projectName || "Unknown Project"}
          </p>
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 ${statusConfig.bgColor}`}
            style={{ color: statusConfig.color }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: statusConfig.color }} />
            {statusConfig.label}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <p className="text-xs text-muted-foreground truncate max-w-[280px]">
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
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors font-mono"
          >
            {deployment.commit.hash.slice(0, 7)}
            {deployment.owner && deployment.repo && <ExternalLink className="size-3" />}
          </button>
        )}

        <DeploymentMenu
          deployment={deployment}
          triggerClassName="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground/50 hover:text-foreground hover:bg-muted transition-colors"
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
