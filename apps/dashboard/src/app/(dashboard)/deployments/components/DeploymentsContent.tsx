"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { deployApi, projectsApi, getApiErrorMessage } from "@/lib/api";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { DeploymentsFilters } from "./DeploymentsFilters";
import { DeploymentsList } from "./DeploymentsList";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { useDeploymentHistoryQuery } from "./use-deployment-history-query";
import type { Deployment, Project } from "../types";
import {
  calculateDeploymentStats,
  mapRowToDeployment,
} from "../utils";

interface DeploymentsContentProps {
  /** When set, scope to this project and hide the project selector */
  projectId?: string;
  projectName?: string;
  hideHeader?: boolean;
  hideSidebar?: boolean;
  /** Catalog-app template id — rows show the app logo instead of the stack icon. */
  appTemplateId?: string;
}

export const DeploymentsContent: React.FC<DeploymentsContentProps> = (props) => (
  <DeploymentHistory key={props.projectId ?? "all-projects"} {...props} />
);

const PAGE_SIZE = 20;

const DeploymentHistory: React.FC<DeploymentsContentProps> = ({
  projectId,
  projectName,
  hideHeader = false,
  hideSidebar = false,
  appTemplateId,
}) => {
  const { t } = useI18n();
  const isProject = !!projectId;

  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useDeploymentHistoryQuery(isProject);
  const { page, filter, searchQuery, selectedProjectId } = query;
  const refreshDeployments = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    const params = {
      page,
      perPage: PAGE_SIZE,
      status: filter === "all" ? undefined : filter,
      search: searchQuery.trim() || undefined,
    };
    const request = projectId
      ? projectsApi.getDeployments(projectId, params, controller.signal)
      : deployApi.getAll({ ...params, projectId: selectedProjectId === "all" ? undefined : selectedProjectId }, controller.signal);
    void request.then((res) => {
      if (controller.signal.aborted) return;
      const lastPage = Math.max(1, Math.ceil(res.total / PAGE_SIZE));
      if (page > lastPage) {
        // Deleting the last row on a page should return to the last real page.
        setQuery((previous) => ({ ...previous, page: lastPage }));
        return;
      }
      const mapped = res.data.map((row) => mapRowToDeployment({
        ...row,
        ...(projectId ? { projectId, projectName: projectName ?? row.projectName } : {}),
      }));
      setDeployments(mapped);
      setTotal(res.total);
      if (!isProject) {
        setProjects((previous) => {
          if (res.projects) return res.projects;
          // Older APIs omit the complete options list; keep already seen
          // options stable while navigating or narrowing the history.
          const known = new Map(previous.map((project) => [project.id, project]));
          for (const deployment of mapped) {
            if (deployment.projectId && deployment.projectName) {
              known.set(deployment.projectId, { id: deployment.projectId, name: deployment.projectName });
            }
          }
          return [...known.values()].sort((a, b) => a.name.localeCompare(b.name));
        });
      }
    }).catch((err) => {
      if (!controller.signal.aborted) setError(getApiErrorMessage(err, t.deployments.loadFailed));
    }).finally(() => {
      if (!controller.signal.aborted) setIsLoading(false);
    });
    return () => controller.abort();
  }, [projectId, projectName, isProject, page, filter, searchQuery, selectedProjectId, revision, t.deployments.loadFailed, setQuery]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const stats = useMemo(() => calculateDeploymentStats(deployments), [deployments]);

  const activeCount = (stats.building || 0) + (stats.pending || 0);
  const failedCount = (stats.failed || 0) + (stats.canceled || 0);

  return (
    <div>
      {/* Header */}
      {!hideHeader && (
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t.deployments.header.title}
          </h1>
          <p className="text-sm text-muted-foreground/70 mt-1">
            {isLoading
              ? t.deployments.header.loading
              : interpolate(
                  total === 1 ? t.deployments.header.countProjectOne : t.deployments.header.countProjectOther,
                  { count: String(total) },
                )}
          </p>
        </div>
      )}

      {/* Main Grid */}
      <div className={hideSidebar ? "" : "grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6"}>
        {/* LEFT COLUMN */}
        <div className="space-y-4 min-w-0">
          <DeploymentsFilters
            isProject={isProject}
            filter={filter}
            searchQuery={searchQuery}
            selectedProjectId={selectedProjectId}
            projects={projects}
            onFilterChange={(value) => setQuery((previous) => ({ ...previous, filter: value, page: 1 }))}
            onSearchChange={(value) => setQuery((previous) => ({ ...previous, searchQuery: value, page: 1 }))}
            onProjectChange={(value) => setQuery((previous) => ({ ...previous, selectedProjectId: value, page: 1 }))}
          />
          {isLoading ? (
            <LoadingSkeleton />
          ) : error ? (
            <div role="alert" className="rounded-2xl border border-danger/20 bg-danger-bg p-4 text-sm">
              <p>{error}</p>
              <button type="button" onClick={refreshDeployments} className="mt-2 font-medium underline">
                {t.deployments.retry}
              </button>
            </div>
          ) : (
            <DeploymentsList
              deployments={deployments}
              hasFilters={filter !== "all" || searchQuery !== "" || selectedProjectId !== "all"}
              onStatusChange={refreshDeployments}
              appTemplateId={appTemplateId}
            />
          )}
          {total > 0 && (
            <nav aria-label={t.deployments.pagination.label} className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
              <span aria-live="polite">
                {isLoading ? t.deployments.header.loading : interpolate(t.deployments.pagination.range, {
                  from: String((page - 1) * PAGE_SIZE + 1),
                  to: String(Math.min(page * PAGE_SIZE, total)),
                  total: String(total),
                })}
              </span>
              <div className="flex items-center gap-3">
                <button type="button" disabled={isLoading || page <= 1}
                  aria-label={t.deployments.pagination.previous}
                  onClick={() => setQuery((previous) => ({ ...previous, page: previous.page - 1 }))}
                  className="rounded-lg border border-border/60 p-2 enabled:hover:bg-muted disabled:opacity-40">
                  <UiIcon name="chevron-left" className="size-4 rtl:rotate-180" />
                </button>
                <span>{interpolate(t.deployments.pagination.pageOf, { page: String(page), total: String(pageCount) })}</span>
                <button type="button" disabled={isLoading || page >= pageCount}
                  aria-label={t.deployments.pagination.next}
                  onClick={() => setQuery((previous) => ({ ...previous, page: previous.page + 1 }))}
                  className="rounded-lg border border-border/60 p-2 enabled:hover:bg-muted disabled:opacity-40">
                  <UiIcon name="chevron-right" className="size-4 rtl:rotate-180" />
                </button>
              </div>
            </nav>
          )}
        </div>

        {/* RIGHT COLUMN (Sticky) */}
        {!hideSidebar && (
          <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            {/* Activity Overview */}
            <div className="bg-card rounded-2xl border border-border/50 p-5">
              <div className="flex items-center gap-2 mb-4">
                <UiIcon name="activity" className="size-4 text-muted-foreground" />
                <h3 className="font-semibold text-foreground text-sm">
                  {t.deployments.sidebar.overview.pageTitle}
                </h3>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                      <UiIcon name="rocket" className="size-4 text-primary" />
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {t.deployments.sidebar.overview.total}
                    </span>
                  </div>
                  <span className="text-lg font-semibold text-foreground">
                    {isLoading ? "–" : stats.total}
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-success-bg flex items-center justify-center">
                      <UiIcon name="check-circle" className="size-4 text-success" />
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {t.deployments.sidebar.overview.successful}
                    </span>
                  </div>
                  <span className="text-lg font-semibold text-foreground">
                    {isLoading ? "–" : stats.success}
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-danger-bg flex items-center justify-center">
                      <UiIcon name="x-circle" className="size-4 text-danger" />
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {t.deployments.sidebar.overview.failed}
                    </span>
                  </div>
                  <span className="text-lg font-semibold text-foreground">
                    {isLoading ? "–" : failedCount}
                  </span>
                </div>

                {activeCount > 0 && (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-warning-bg flex items-center justify-center">
                        <UiIcon name="spinner" className="size-4 text-warning animate-spin" />
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {t.deployments.sidebar.overview.inProgress}
                      </span>
                    </div>
                    <span className="text-lg font-semibold text-foreground">{activeCount}</span>
                  </div>
                )}
              </div>

              {/* Success/failure proportion — at-a-glance fleet health, same
                semantic colors as the stat rows above. */}
              {!isLoading && stats.total > 0 && (
                <div className="mt-4 flex h-1.5 overflow-hidden rounded-full bg-muted/40">
                  {stats.success > 0 && (
                    <div
                      className="bg-success-solid"
                      style={{ width: `${(stats.success / stats.total) * 100}%` }}
                    />
                  )}
                  {failedCount > 0 && (
                    <div
                      className="bg-danger-solid"
                      style={{ width: `${(failedCount / stats.total) * 100}%` }}
                    />
                  )}
                  {activeCount > 0 && (
                    <div
                      className="bg-warning-solid"
                      style={{ width: `${(activeCount / stats.total) * 100}%` }}
                    />
                  )}
                </div>
              )}
            </div>

            {/* Quick Tip */}
            {deployments.length > 0 ? (
              <div className="bg-gradient-to-br from-primary/5 via-primary/3 to-transparent rounded-2xl border border-primary/10 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <UiIcon name="bolt" className="size-4 text-primary" />
                  <h3 className="font-semibold text-foreground text-sm">
                    {t.deployments.sidebar.autoDeploy.title}
                  </h3>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {t.deployments.sidebar.autoDeploy.description}
                </p>
                {!isProject && (
                  <Link
                    href="/projects"
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary/80 mt-3 transition-colors"
                  >
                    {t.deployments.sidebar.autoDeploy.cta}
                    <UiIcon name="arrow-right" className="size-3.5 rtl:rotate-180" />
                  </Link>
                )}
              </div>
            ) : (
              <div className="bg-gradient-to-br from-primary/5 via-primary/3 to-transparent rounded-2xl border border-primary/10 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <UiIcon name="bolt" className="size-4 text-primary" />
                  <h3 className="font-semibold text-foreground text-sm">
                    {t.deployments.sidebar.getStarted.title}
                  </h3>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {t.deployments.sidebar.getStarted.description}
                </p>
                <Link
                  href="/library"
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary/80 mt-3 transition-colors"
                >
                  {t.deployments.sidebar.getStarted.cta}
                  <UiIcon name="arrow-right" className="size-3.5 rtl:rotate-180" />
                </Link>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
