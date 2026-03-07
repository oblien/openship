"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { generateIcon } from "@/utils/icons";
import { DeploymentMenu } from "./DeploymentMenu";
import { CommitDetailsModal } from "./CommitDetailsModal";
import type { Deployment } from "../types";
import { formatDistanceToNow, formatBuildTime, getStatusConfig } from "@/utils/deployment";
import { Info } from "lucide-react";
import { getFrameworkConfig } from "@/components/import-project/Frameworks";

interface DeploymentCardProps {
  deployment: Deployment;
}

export const DeploymentCard: React.FC<DeploymentCardProps> = ({ deployment }) => {
  const router = useRouter();
  const [isCommitModalOpen, setIsCommitModalOpen] = useState(false);
  const statusConfig = getStatusConfig(deployment.status);
  const frameworkConfig = getFrameworkConfig(deployment.framework);

  const handleViewBuild = () => {
    router.push(`/build/${deployment.id}`);
  };

  const handleViewProject = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (deployment.projectId) {
      router.push(`/projects/${deployment.projectId}`);
    }
  };

  const handleOpenDomain = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (deployment.domain) {
      window.open(`https://${deployment.domain}`, "_blank");
    }
  };

  const hasCommitData = deployment.commit && deployment.commit.hash && deployment.commit.hash !== 'N/A';
  const hasCommitMessage = deployment.commit?.message && deployment.commit.message !== 'Manual deployment';

  return (
    <div className="bg-white rounded-[20px] transition-all group">
      <div className="flex flex-col lg:flex-row lg:items-center gap-4 lg:gap-6 p-4" onClick={handleViewBuild} style={{ cursor: 'pointer' }}>

        {/* Left: Framework Icon + Project Name + Status */}
        <div className="flex items-center gap-3 lg:gap-4 min-w-0 lg:w-[340px]">
          <div className="w-12 h-12 lg:w-14 lg:h-14 rounded-xl bg-indigo-50 flex items-center justify-center flex-shrink-0 group-hover:bg-indigo-100 transition-all">
            {frameworkConfig.icon ? (
              frameworkConfig.icon("rgba(99, 102, 241, 1)")
            ) : (
              generateIcon('code-1-1663582768.png', 28, 'rgba(99, 102, 241, 1)')
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm lg:text-base font-semibold text-black truncate mb-1">
              {deployment.projectName || 'Unknown Project'}
            </h3>
            <p className="text-xs lg:text-sm text-black/50 truncate">{deployment.domain || 'No domain'}</p>
          </div>

          <span className={`inline-flex items-center gap-1.5 px-2.5 lg:px-3 py-1 lg:py-1.5 rounded-full text-[10px] lg:text-xs font-medium ${statusConfig.bgColor} ${statusConfig.borderColor} border flex-shrink-0`}
            style={{
              color: statusConfig.color
            }}
          >
            <span className={`w-1.5 h-1.5 rounded-full`} style={{ backgroundColor: statusConfig.color }}></span>
            {statusConfig.label}
          </span>
        </div>

        {/* Middle: Commit Message / Build Info */}
        <div className="flex-1 min-w-0 lg:pl-4">
          <p className="text-sm lg:text-base font-medium text-black truncate mb-2">
            {hasCommitMessage
              ? deployment.commit.message
              : 'Manual Deployment'}
          </p>
          <div className="flex items-center gap-2 lg:gap-3 text-xs lg:text-sm text-black/50 flex-wrap">
            {/* Deployed Time */}
            <div className="flex items-center gap-1.5">
              {generateIcon('calendar-70-1688358192.png', 14, 'rgba(0, 0, 0, 0.5)')}
              <span>{formatDistanceToNow(new Date(deployment.createdAt))}</span>
            </div>
            <span className="text-black/20 hidden sm:inline">•</span>

            {/* Build Time or Status */}
            {deployment.buildTime ? (
              <div className="flex items-center gap-1.5">
                {generateIcon('circle%20clock-39-1658435834.png', 14, 'rgba(0, 0, 0, 0.5)')}
                <span>{formatBuildTime(deployment.buildTime)}</span>
              </div>
            ) : null}

            {/* Branch */}
            {deployment.branch && (
              <>
                <span className="text-black/20 hidden sm:inline">•</span>
                <div className="flex items-center gap-1.5">
                  {generateIcon('git%20branch-159-1658431404.png', 14, 'rgba(0, 0, 0, 0.5)')}
                  <span>{deployment.branch}</span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Right: Commit Hash / ID with Details Button and Menu */}
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap lg:flex-nowrap ml-auto">
          {hasCommitData && deployment.commit.hash ? (
            <div
              onClick={(e) => {
                e.stopPropagation();
                if (deployment.owner && deployment.repo) {
                  window.open(`https://github.com/${deployment.owner}/${deployment.repo}/commit/${deployment.commit.fullHash || deployment.commit.hash}`, "_blank");
                }
              }}
              className={`inline-flex items-center gap-2 px-3 lg:px-4 py-2 lg:py-2.5 bg-white border border-black/10 rounded-full text-xs lg:text-sm text-black/70 transition-all ${deployment.owner && deployment.repo ? 'hover:bg-black/5 hover:text-black cursor-pointer' : ''
                }`}
            >
              {generateIcon('commit%20git-149-1658431404.png', 18, 'currentColor')}
              <code className="max-w-[80px] lg:max-w-[120px] truncate font-medium font-mono">{deployment.commit.hash}</code>
              {deployment.owner && deployment.repo && (
                generateIcon('External_link_HtLszLDBXqHilHK674zh2aKoSL7xUhyboAzP.png', 12, 'currentColor')
              )}
            </div>
          ) : (
            <div className="inline-flex items-center gap-2 px-3 lg:px-4 py-2 lg:py-2.5 bg-white border border-black/10 rounded-full text-xs lg:text-sm text-black/70">
              {generateIcon('hashtag-112-1658432731.png', 16, 'rgba(0, 0, 0, 0.5)')}
              <code className="font-medium font-mono">{(deployment.id || 'N/A').substring(0, 8)}</code>
            </div>
          )}

          {/* View Commit Details Button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsCommitModalOpen(true);
            }}
            className="inline-flex items-center gap-2 px-3 lg:px-4 py-2 lg:py-2.5 bg-indigo-50 border border-indigo-200 rounded-full text-xs lg:text-sm text-indigo-700 hover:bg-indigo-100 transition-all font-medium"
            title="View commit details"
          >
            <Info className="w-3.5 h-3.5 lg:w-4 lg:h-4" />
            <span className="hidden sm:inline">Details</span>
          </button>

          {/* Actions - Menu Button */}
          <DeploymentMenu
            deployment={deployment}
            triggerClassName="w-9 h-9 lg:w-10 lg:h-10 flex items-center justify-center border border-black/10 hover:bg-black/5 text-black/50 hover:text-black rounded-full transition-all"
          />
        </div>
      </div>

      {/* Commit Details Modal */}
      <CommitDetailsModal
        deployment={deployment}
        isOpen={isCommitModalOpen}
        onClose={() => setIsCommitModalOpen(false)}
      />
    </div>
  );
};
