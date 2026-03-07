"use client";

import React, { useState, useEffect, useMemo } from "react";
import { projectsApi } from "@/lib/api";
import {
  DeploymentsFilters,
  DeploymentsList,
  DeploymentHeader,
  LoadingSkeleton,
} from "./components";
import type { Deployment, Project } from "./types";
import { calculateDeploymentStats, filterDeployments, sortDeploymentsByDate } from "./utils";
import { SectionContainer } from "@/components/ui/SectionContainer";

export default function DeploymentsPage() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "success" | "failed" | "building" | "pending" | "canceled">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string | "all">("all");

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      try {
        const deploymentsResponse = await projectsApi.getAllDeployments();

        if (deploymentsResponse.success && Array.isArray(deploymentsResponse.deployments)) {
          // Sort by creation date (most recent first)
          const sortedDeployments = sortDeploymentsByDate(deploymentsResponse.deployments);
          setDeployments(sortedDeployments);

          // Extract unique projects from deployments
          const uniqueProjects = Array.from(
            new Map(
              deploymentsResponse.deployments
                .filter((d: any) => d.projectId && d.projectName)
                .map((d: any) => [d.projectId, { id: d.projectId, name: d.projectName }])
            ).values()
          ) as Project[];
          
          setProjects(uniqueProjects);
        }
      } catch (error) {
        console.error("Error fetching deployments:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, []);

  // Memoized filtered deployments - only recalculate when dependencies change
  const filteredDeployments = useMemo(() => {
    return filterDeployments(deployments, {
      status: filter,
      searchQuery,
      projectId: selectedProjectId,
    });
  }, [deployments, filter, searchQuery, selectedProjectId]);

  // Memoized stats - only recalculate when deployments change
  const stats = useMemo(() => {
    return calculateDeploymentStats(deployments);
  }, [deployments]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#fafafa]">
        <SectionContainer>
          <LoadingSkeleton />
        </SectionContainer>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#fafafa]">
      <SectionContainer>
        {/* Page Header */}
        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold text-black mb-2" style={{ letterSpacing: '-0.5px' }}>
            All Deployments
          </h1>
          <p className="text-sm sm:text-base text-black/50 font-normal">
            View and manage all deployments across your projects
          </p>
        </div>

        {/* Stats Header */}
        <div className="mb-6">
          <DeploymentHeader stats={stats} projectCount={projects.length} />
        </div>

        {/* Filters */}
        <div className="mb-6">
          <DeploymentsFilters
            isProject={false}
            filter={filter}
            searchQuery={searchQuery}
            selectedProjectId={selectedProjectId}
            projects={projects}
            onFilterChange={setFilter}
            onSearchChange={setSearchQuery}
            onProjectChange={setSelectedProjectId}
          />
        </div>

        {/* Deployment List */}
        <DeploymentsList
          deployments={filteredDeployments}
          hasFilters={filter !== "all" || searchQuery !== "" || selectedProjectId !== "all"}
        />
      </SectionContainer>
    </div>
  );
}
