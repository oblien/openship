"use client";

import React, { useState, useEffect, useMemo } from "react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import {
  DeploymentHeader,
  DeploymentsFilters,
  LoadingSkeleton,
  DeploymentCard,
  EmptyState,
} from "@/components/global-deployments";

export const Deployments = () => {
  const { deployments, id, fetchDeployments, deploymentsLoading } = useProjectSettings();
  const [filter, setFilter] = useState<"all" | "success" | "failed" | "building" | "pending" | "canceled">("all");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    fetchDeployments()
  }, []);

  // Filter deployments
  const filteredDeployments = useMemo(() => deployments.filter((deployment: any) => {
    const matchesFilter = filter === "all" || deployment.status === filter;
    const matchesSearch =
      !searchQuery ||
      deployment.commit.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
      deployment.commit.hash.toLowerCase().includes(searchQuery.toLowerCase()) ||
      deployment.commit.author.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesFilter && matchesSearch;
  }), [deployments, filter, searchQuery]);

  // Calculate stats
  const stats = {
    total: deployments.length,
    success: deployments.filter((d: any) => d.status === "success").length,
    failed: deployments.filter((d: any) => d.status === "failed").length,
    building: deployments.filter((d: any) => d.status === "building").length,
  };

  if (deploymentsLoading) {
    return <LoadingSkeleton />;
  }

  return (
    <div className="space-y-5">
      {/* Stats Header */}
      <DeploymentHeader stats={stats} />

      {/* Filters */}
      <DeploymentsFilters
        filter={filter}
        searchQuery={searchQuery}
        isProject={true}
        onFilterChange={setFilter}
        onSearchChange={setSearchQuery}
        selectedProjectId="all"
        projects={[]}
        onProjectChange={() => { }}
      />

      {/* Deployment List */}
      {filteredDeployments.length === 0 ? (
        <EmptyState hasFilters={filter !== "all" || searchQuery !== ""} />
      ) : (
        <div className="space-y-4">
          {filteredDeployments.map((deployment: any, index: number) => (
            <DeploymentCard key={`${deployment.id}-${index}`} deployment={deployment} />
          ))}
        </div>
      )}
    </div>
  );
};
