"use client";

import React from "react";
import { DeploymentCard } from "./DeploymentCard";
import { EmptyState } from "./EmptyState";
import type { Deployment } from "../types";

interface DeploymentsListProps {
  deployments: Deployment[];
  hasFilters: boolean;
}

export const DeploymentsList: React.FC<DeploymentsListProps> = ({
  deployments,
  hasFilters,
}) => {
  if (deployments.length === 0) {
    return <EmptyState hasFilters={hasFilters} />;
  }

  return (
    <div className="space-y-4">
      {deployments.map((deployment,index) => (
        <DeploymentCard key={index} deployment={deployment} />
      ))}
    </div>
  );
};

