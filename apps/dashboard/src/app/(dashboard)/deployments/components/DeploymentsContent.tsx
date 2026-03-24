"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import {
  Rocket,
  Activity,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  Zap,
  ArrowRight,
} from "lucide-react";
import { deployApi, projectsApi } from "@/lib/api";
import { DeploymentsFilters } from "./DeploymentsFilters";
import { DeploymentsList } from "./DeploymentsList";
import { LoadingSkeleton } from "./LoadingSkeleton";
import type { Deployment, Project } from "../types";
import {
  calculateDeploymentStats,
  filterDeployments,
  sortDeploymentsByDate,
  mapRowToDeployment,
  formatDistanceToNow,
} from "../utils";

interface DeploymentsContentProps {
  /** When set, scope to this project and hide the project selector */
  projectId?: string;
  projectName?: string;
  hideHeader?: boolean;
  hideSidebar?: boolean;
}

export const DeploymentsContent: React.FC<DeploymentsContentProps> = ({
  projectId,
  projectName,
  hideHeader = false,
  hideSidebar = false,
}) => {
  const isProject = !!projectId;

  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<
    "all" | "success" | "failed" | "building" | "pending" | "canceled"
  >("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string | "all">(
    "all"
  );

  const fetchDeployments = useCallback(async () => {
    setIsLoading(true);
    try {
      if (isProject && projectId) {
        const res = await projectsApi.getDeployments(projectId);
        const rows: any[] = res.data ?? res.deployments ?? [];
        const mapped = rows.map((r: any) =>
          mapRowToDeployment({
            ...r,
            projectId,
            projectName: projectName ?? r.projectName,
          })
        );
        setDeployments(sortDeploymentsByDate(mapped));
        setProjects([]);
      } else {
        const res = await deployApi.getAll({ perPage: 100 });
        const rows: any[] = res.data ?? [];
        const mapped = rows.map(mapRowToDeployment);
        setDeployments(sortDeploymentsByDate(mapped));

        const projectMap = new Map<string, Project>();
        for (const d of mapped) {
          if (d.projectId && d.projectName) {
            projectMap.set(d.projectId, {
              id: d.projectId,
              name: d.projectName,
            });
          }
        }
        setProjects([...projectMap.values()]);
      }
    } catch {
      /* silent */
    } finally {
      setIsLoading(false);
    }
  }, [isProject, projectId, projectName]);

  useEffect(() => {
    fetchDeployments();
  }, [fetchDeployments]);

  const filteredDeployments = useMemo(
    () =>
      filterDeployments(deployments, {
        status: filter,
        searchQuery,
        projectId: selectedProjectId,
      }),
    [deployments, filter, searchQuery, selectedProjectId]
  );

  const stats = useMemo(
    () => calculateDeploymentStats(deployments),
    [deployments]
  );

  const activeCount = (stats.building || 0) + (stats.pending || 0);
  const recentDeployments = deployments.slice(0, 4);

  return (
    <div>
      {/* Header */}
      {!hideHeader && (
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-9 h-9 bg-primary/10 rounded-xl flex items-center justify-center">
              <Rocket className="size-[18px] text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: "-0.2px" }}>
                Deployments
              </h1>
              <p className="text-xs text-muted-foreground">
                {isLoading
                  ? "Loading..."
                  : isProject
                    ? `${deployments.length} deployment${deployments.length !== 1 ? "s" : ""}`
                    : `${deployments.length} total across ${projects.length} project${projects.length !== 1 ? "s" : ""}`}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Main Grid */}
      <div className={hideSidebar ? "" : "grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6"}>
        {/* LEFT COLUMN */}
        <div className="space-y-4 min-w-0">
          {isLoading ? (
            <LoadingSkeleton />
          ) : (
            <>
              <DeploymentsFilters
                isProject={isProject}
                filter={filter}
                searchQuery={searchQuery}
                selectedProjectId={selectedProjectId}
                projects={projects}
                onFilterChange={setFilter}
                onSearchChange={setSearchQuery}
                onProjectChange={setSelectedProjectId}
              />

              <DeploymentsList
                deployments={filteredDeployments}
                hasFilters={
                  filter !== "all" ||
                  searchQuery !== "" ||
                  selectedProjectId !== "all"
                }
                onStatusChange={fetchDeployments}
              />
            </>
          )}
        </div>

        {/* RIGHT COLUMN (Sticky) */}
        {!hideSidebar && (
        <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          {/* Activity Overview */}
          <div className="bg-card rounded-2xl border border-border/50 p-5">
            <div className="flex items-center gap-2 mb-4">
              <Activity className="size-4 text-muted-foreground" />
              <h3 className="font-semibold text-foreground text-sm">Overview</h3>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Rocket className="size-4 text-primary" />
                  </div>
                  <span className="text-sm text-muted-foreground">Total</span>
                </div>
                <span className="text-lg font-semibold text-foreground">
                  {isLoading ? "–" : stats.total}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                    <CheckCircle2 className="size-4 text-emerald-500" />
                  </div>
                  <span className="text-sm text-muted-foreground">Successful</span>
                </div>
                <span className="text-lg font-semibold text-foreground">
                  {isLoading ? "–" : stats.success}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center">
                    <XCircle className="size-4 text-red-500" />
                  </div>
                  <span className="text-sm text-muted-foreground">Failed</span>
                </div>
                <span className="text-lg font-semibold text-foreground">
                  {isLoading ? "–" : (stats.failed || 0) + (stats.canceled || 0)}
                </span>
              </div>

              {activeCount > 0 && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                      <Loader2 className="size-4 text-amber-500 animate-spin" />
                    </div>
                    <span className="text-sm text-muted-foreground">In Progress</span>
                  </div>
                  <span className="text-lg font-semibold text-foreground">{activeCount}</span>
                </div>
              )}
            </div>
          </div>

          {/* Quick Tip */}
          {deployments.length > 0 ? (
            <div className="bg-gradient-to-br from-primary/5 via-primary/3 to-transparent rounded-2xl border border-primary/10 p-5">
              <div className="flex items-center gap-2 mb-3">
                <Zap className="size-4 text-primary" />
                <h3 className="font-semibold text-foreground text-sm">Auto-Deploy</h3>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Enable auto-deploy to trigger deployments automatically on every push to your main branch.
              </p>
              {!isProject && (
                <Link
                  href="/projects"
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary/80 mt-3 transition-colors"
                >
                  Go to project settings
                  <ArrowRight className="size-3.5" />
                </Link>
              )}
            </div>
          ) : (
            <div className="bg-gradient-to-br from-primary/5 via-primary/3 to-transparent rounded-2xl border border-primary/10 p-5">
              <div className="flex items-center gap-2 mb-3">
                <Zap className="size-4 text-primary" />
                <h3 className="font-semibold text-foreground text-sm">Get Started</h3>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Import a Git repository or use a template to create your first deployment.
              </p>
              <Link
                href="/library"
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary/80 mt-3 transition-colors"
              >
                Deploy a project
                <ArrowRight className="size-3.5" />
              </Link>
            </div>
          )}

          {/* Recent Deployments */}
          <div className="bg-card rounded-2xl border border-border/50 p-5">
            <div className="flex items-center gap-2 mb-4">
              <Clock className="size-4 text-muted-foreground" />
              <h3 className="font-semibold text-foreground text-sm">Recent</h3>
            </div>

            {isLoading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="flex items-center gap-3 animate-pulse">
                    <div className="w-2 h-2 rounded-full bg-muted" />
                    <div className="flex-1 h-4 bg-muted rounded" />
                  </div>
                ))}
              </div>
            ) : recentDeployments.length === 0 ? (
              <div className="text-center py-4">
                <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center mx-auto mb-3">
                  <Clock className="size-4 text-muted-foreground/50" />
                </div>
                <p className="text-xs text-muted-foreground/70">
                  Your deployments will appear here
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {recentDeployments.map((d) => (
                  <Link
                    key={d.id}
                    href={`/build/${d.id}`}
                    className="flex items-center gap-3 group"
                  >
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        d.status === "success" ? "bg-emerald-500" :
                        d.status === "failed" ? "bg-red-500" :
                        d.status === "building" ? "bg-amber-500" :
                        "bg-muted-foreground/40"
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground truncate group-hover:text-primary transition-colors">
                        {d.projectName || "Unknown"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(d.createdAt))}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
};
