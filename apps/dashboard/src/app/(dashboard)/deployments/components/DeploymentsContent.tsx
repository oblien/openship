"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Rocket, Activity, CheckCircle2, XCircle, Loader2, Zap, ArrowRight } from "lucide-react";
import { deployApi, projectsApi } from "@/lib/api";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { DeploymentsFilters } from "./DeploymentsFilters";
import { DeploymentsList } from "./DeploymentsList";
import { LoadingSkeleton } from "./LoadingSkeleton";
import type { Deployment, Project } from "../types";
import {
  calculateDeploymentStats,
  filterDeployments,
  sortDeploymentsByDate,
  mapRowToDeployment,
} from "../utils";

type StatusFilter =
  | "all"
  | "success"
  | "failed"
  | "building"
  | "pending"
  | "canceled";

const STATUS_FILTERS: readonly StatusFilter[] = [
  "all",
  "success",
  "failed",
  "building",
  "pending",
  "canceled",
];

/** Query keys the standalone /deployments view keeps its filters in. */
const P_STATUS = "status";
const P_PROJECT = "project";
const P_QUERY = "q";

/** Only accept a status the filter actually has, so a hand-edited URL can't wedge
 *  the list on a value `filterDeployments` will never match. */
function readStatus(raw: string | null): StatusFilter {
  return STATUS_FILTERS.includes(raw as StatusFilter) ? (raw as StatusFilter) : "all";
}

/** Keep the URL clean: a filter at its default is absent, not `?status=all`. */
function setOrDelete(params: URLSearchParams, key: string, value: string, dflt: string) {
  if (value === dflt) params.delete(key);
  else params.set(key, value);
}

interface DeploymentsContentProps {
  /** When set, scope to this project and hide the project selector */
  projectId?: string;
  projectName?: string;
  hideHeader?: boolean;
  hideSidebar?: boolean;
  /** Catalog-app template id — rows show the app logo instead of the stack icon. */
  appTemplateId?: string;
}

export const DeploymentsContent: React.FC<DeploymentsContentProps> = ({
  projectId,
  projectName,
  hideHeader = false,
  hideSidebar = false,
  appTemplateId,
}) => {
  const { t } = useI18n();
  const isProject = !!projectId;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /**
   * Filters are mirrored into the URL on the standalone /deployments view, so
   * opening a deployment and pressing Back returns to the list you were looking at.
   * They used to be component state only: Back remounts this component, every
   * filter reset to "all", and a filtered-down list silently became the full one.
   *
   * Scoped to the standalone view on purpose. Embedded in a project (`isProject`)
   * the list is already one project's, the project selector is hidden, and that
   * page owns its own URL — it rewrites it to `/projects/:id/:tab` after reading
   * its params, which would strip anything written here and fight the sync below.
   *
   * Read once per mount: a Back navigation IS a fresh mount, which is exactly when
   * the URL should seed the state.
   */
  const urlFilters = !isProject;

  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>(() =>
    urlFilters ? readStatus(searchParams.get(P_STATUS)) : "all",
  );
  const [searchQuery, setSearchQuery] = useState(() =>
    urlFilters ? (searchParams.get(P_QUERY) ?? "") : "",
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | "all">(() =>
    urlFilters ? (searchParams.get(P_PROJECT) ?? "all") : "all",
  );

  // Write the current filters back to the URL. `replace`, not `push`, so filtering
  // never builds up history entries the Back button has to chew through — and
  // `scroll: false` so re-filtering doesn't jump the list to the top. Bails when the
  // query string is already correct, which is the mount case: no redundant
  // navigation, and no loop with the effect's own dependency on searchParams.
  useEffect(() => {
    if (!urlFilters) return;
    const next = new URLSearchParams(Array.from(searchParams.entries()));
    setOrDelete(next, P_STATUS, filter, "all");
    setOrDelete(next, P_QUERY, searchQuery, "");
    setOrDelete(next, P_PROJECT, selectedProjectId, "all");
    const qs = next.toString();
    if (qs === searchParams.toString()) return;
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [urlFilters, filter, searchQuery, selectedProjectId, searchParams, pathname, router]);

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
          }),
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
    [deployments, filter, searchQuery, selectedProjectId],
  );

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
              : isProject
                ? interpolate(
                    deployments.length === 1
                      ? t.deployments.header.countProjectOne
                      : t.deployments.header.countProjectOther,
                    { count: String(deployments.length) },
                  )
                : interpolate(
                    projects.length === 1
                      ? t.deployments.header.countAllOne
                      : t.deployments.header.countAllOther,
                    {
                      deployments: String(deployments.length),
                      projects: String(projects.length),
                    },
                  )}
          </p>
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
                hasFilters={filter !== "all" || searchQuery !== "" || selectedProjectId !== "all"}
                onStatusChange={fetchDeployments}
                appTemplateId={appTemplateId}
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
                <h3 className="font-semibold text-foreground text-sm">
                  {t.deployments.sidebar.overview.title}
                </h3>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                      <Rocket className="size-4 text-primary" />
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
                      <CheckCircle2 className="size-4 text-success" />
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
                      <XCircle className="size-4 text-danger" />
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
                        <Loader2 className="size-4 text-warning animate-spin" />
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
                  <Zap className="size-4 text-primary" />
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
                    <ArrowRight className="size-3.5 rtl:rotate-180" />
                  </Link>
                )}
              </div>
            ) : (
              <div className="bg-gradient-to-br from-primary/5 via-primary/3 to-transparent rounded-2xl border border-primary/10 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Zap className="size-4 text-primary" />
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
                  <ArrowRight className="size-3.5 rtl:rotate-180" />
                </Link>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
