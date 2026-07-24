"use client";

import React from "react";
import { DeploymentCard } from "./DeploymentCard";
import { EmptyState } from "./EmptyState";
import type { Deployment } from "../types";

interface DeploymentsListProps {
  deployments: Deployment[];
  hasFilters: boolean;
  onStatusChange?: () => void;
  /** Catalog-app template id — makes the rows show the app logo. */
  appTemplateId?: string;
}

export const DeploymentsList: React.FC<DeploymentsListProps> = ({
  deployments,
  hasFilters,
  onStatusChange,
  appTemplateId,
}) => {
  if (deployments.length === 0) {
    return <EmptyState hasFilters={hasFilters} />;
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50 divide-y divide-border/50">
      {deployments.map((deployment, index) => (
        <DeploymentCard
          key={deployment.id || index}
          deployment={deployment}
          onStatusChange={onStatusChange}
          appTemplateId={appTemplateId}
        />
      ))}
    </div>
  );
};
