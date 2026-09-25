"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { Deployment } from "@/constants/mock";
import { formatDate } from "@/utils/date";
import React from "react";
import { useI18n } from "@/components/i18n-provider";

interface Props {
  deployment: Deployment;
}

const DeploymentCard = ({ deployment }: Props) => {
  const { t } = useI18n();
  const getStatusColor = (status: string) => {
    switch (status) {
      case "success":
        return "text-success bg-success-bg";
      case "failed":
        return "text-danger bg-danger-bg";
      default:
        return "text-warning bg-warning-bg";
    }
  };

  return (
    <div
      className="bg-white rounded-lg border border-gray-200 p-5 hover:border-gray-300 transition-all"
    >
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <h4 className="text-base font-semibold text-gray-900">
              {deployment.projectName}
            </h4>
            <span className="text-xs text-gray-500  bg-gray-100 px-2 py-0.5 rounded">
              #{deployment.commit}
            </span>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${getStatusColor(
                deployment.status
              )}`}
            >
              {deployment.status}
            </span>
          </div>

          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <UiIcon name="git-branch" className="w-3.5 h-3.5" />
              {deployment.branch}
            </span>
            <span>{formatDate(deployment.createdAt)}</span>
            <span className="flex items-center gap-1.5">
              <UiIcon name="clock" className="w-3.5 h-3.5" />
              {deployment.duration}
            </span>
          </div>
        </div>

        {deployment.status === "success" && (
          <a
            href={deployment.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-900 hover:bg-gray-800 text-white text-sm rounded-md transition-colors"
          >
            <UiIcon name="external-link" className="w-3.5 h-3.5" />
            {t.projects.deploymentCard.visit}
          </a>
        )}
      </div>
    </div>
  );
};

export default DeploymentCard;