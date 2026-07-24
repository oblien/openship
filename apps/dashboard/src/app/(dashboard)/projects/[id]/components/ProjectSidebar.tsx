"use client";

import { useMemo } from "react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { usePlatform } from "@/context/PlatformContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { AppLogo } from "@/components/AppLogo";
import { DomainSwitcher } from "@/components/routing/DomainSwitcher";
import { formatDate } from "@/utils/date";
import { getProjectStatus, PROJECT_STATUS_META, projectStatusLabel } from "@/utils/project-status";
import {
  LayoutDashboard,
  Activity,
  Globe,
  Rocket,
  GitBranch,
  Wrench,
  ScrollText,
  AlertTriangle,
  Layers,
  ExternalLink,
  DatabaseBackup,
  Plus,
} from "lucide-react";

const TAB_ICONS: Record<
  string,
  React.ComponentType<{ className?: string; strokeWidth?: number }>
> = {
  overview: LayoutDashboard,
  monitoring: Activity,
  services: Layers,
  domains: Globe,
  deployments: Rocket,
  source: GitBranch,
  runtime: Wrench,
  settings: Wrench,
  logs: ScrollText,
  backup: DatabaseBackup,
  advanced: AlertTriangle,
};

/**
 * Domains tab needs attention when routing failed but the deploy still
 * succeeded (`routingUnsynced` — domains are optional, so a routing failure
 * never fails a deploy; it's flagged here instead) OR a domain row is in a hard
 * failure state (registration failed / SSL errored). Drives the Domains-tab
 * yellow dot. Pending/unverified rows are NOT flagged (normal in-progress DNS).
 */
function domainsNeedAttention(
  projectData: Record<string, unknown> | undefined,
  domainsData?: { domains?: Array<{ status?: string; sslStatus?: string }> | undefined },
): boolean {
  if (projectData?.routingUnsynced) return true;
  return (domainsData?.domains ?? []).some(
    (d) => d?.status === "failed" || d?.sslStatus === "error",
  );
}

/** Desktop right-column navigation - matches LibrarySidebar / Home pattern */
export const ProjectSidebar = () => {
  const {
    projectData,
    projectNotFound,
    activeTab,
    tabs,
    setActiveTab,
    domain,
    domainsData,
    selectedDomain,
    setSelectedDomain,
  } = useProjectSettings();
  const { t } = useI18n();
  const { selfHosted } = usePlatform();
  const status = getProjectStatus(projectData);
  const meta = PROJECT_STATUS_META[status];
  const domainsAttention = domainsNeedAttention(projectData, domainsData);
  const localPort = projectData.port || 3000;
  const localUrl = `localhost:${localPort}`;

  // Route switch: pick which domain the Production line shows/opens (shared via
  // context so switching here also refetches the overview analytics).
  const domains = useMemo(
    () =>
      (domainsData?.domains ?? [])
        .map((d: any) => d?.domain)
        .filter((d: unknown): d is string => typeof d === "string" && d.length > 0),
    [domainsData?.domains],
  );

  const activeDomain = selectedDomain || domain || "";
  const hasDomain = !!activeDomain;
  // A dev box with no managed domain is reachable at localhost; a self-hosted
  // project with no assigned domain has NO public URL — show a "No domain"
  // placeholder + an Add affordance rather than synthesize a fake slug domain.
  const isLocalDev = !hasDomain && !selfHosted;
  const canOpen = hasDomain || isLocalDev;
  const displayUrl = hasDomain ? activeDomain : localUrl;
  const siteHref = isLocalDev ? `http://${localUrl}` : `https://${activeDomain}`;

  const handleTabChange = (tabId: string) => {
    const scrollY = window.scrollY;
    setActiveTab(tabId);
    window.history.replaceState({}, "", `/projects/${projectData.id}/${tabId}`);
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  };

  if (!projectData.id || projectNotFound) {
    return null;
  }

  return (
    <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
      <div className="bg-card rounded-2xl border border-border/50 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {projectData.isApp && projectData.appTemplateId && (
              <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-muted/40">
                <AppLogo appId={projectData.appTemplateId} className="size-5" />
              </div>
            )}
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
                {t.projects.sidebar.project}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <h3 className="truncate text-base font-semibold text-foreground">
                  {projectData.name || t.projects.sidebar.untitledProject}
                </h3>
                {canOpen && (
                  <a
                    href={siteHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={interpolate(t.projects.sidebar.openAria, {
                      name: projectData.name || t.projects.sidebar.openProjectFallback,
                    })}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-primary"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
              </div>
            </div>
          </div>
          <span
            className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${meta.badge}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
            {projectStatusLabel(status, t)}
          </span>
        </div>

        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-muted-foreground">
              {isLocalDev ? t.projects.sidebar.local : t.projects.sidebar.production}
            </span>
            {canOpen ? (
              <div className="flex min-w-0 items-center gap-1.5">
                {domains.length > 1 ? (
                  <DomainSwitcher
                    domains={domains}
                    value={activeDomain}
                    onChange={setSelectedDomain}
                  />
                ) : (
                  <span className="truncate text-sm font-medium text-foreground">{displayUrl}</span>
                )}
                <a
                  href={siteHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t.projects.sidebar.open}
                  className="shrink-0 text-muted-foreground transition-colors hover:text-primary"
                >
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              </div>
            ) : (
              // No assigned domain — show a placeholder + jump to the Domains tab
              // to add one (never synthesize a fake slug domain).
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground/50">
                  {t.projects.sidebar.noDomain}
                </span>
                <button
                  type="button"
                  onClick={() => handleTabChange("domains")}
                  className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary transition-opacity hover:opacity-80"
                >
                  <Plus className="size-3.5" />
                  {t.projects.sidebar.addDomain}
                </button>
              </div>
            )}
          </div>
          {projectData.last_deployed && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-muted-foreground">{t.projects.sidebar.lastDeploy}</span>
              <p className="truncate text-sm font-medium text-foreground">
                {formatDate(projectData.last_deployed)}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="bg-card rounded-2xl border border-border/50 p-3">
        <div className="space-y-1">
          {tabs.map((tab) => {
            const Icon = TAB_ICONS[tab.id] || LayoutDashboard;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-medium transition-colors ${
                  isActive
                    ? "bg-foreground/[0.07] text-foreground"
                    : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
                }`}
              >
                <Icon className="size-[17px] shrink-0" strokeWidth={1.7} />
                {tab.label}
                {tab.id === "domains" && domainsAttention && (
                  <span
                    className="ms-auto size-1.5 rounded-full bg-warning-solid"
                    aria-label="Routing needs attention"
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/** Mobile horizontal scroll tabs - rendered above content in left column */
export const ProjectMobileTabs = () => {
  const { projectData, projectNotFound, activeTab, tabs, setActiveTab, domainsData } = useProjectSettings();
  const domainsAttention = domainsNeedAttention(projectData, domainsData);

  const handleTabChange = (tabId: string) => {
    const scrollY = window.scrollY;
    setActiveTab(tabId);
    window.history.replaceState({}, "", `/projects/${projectData.id}/${tabId}`);
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  };

  if (!projectData.id || projectNotFound) {
    return null;
  }

  return (
    <div className="lg:hidden sticky top-0 z-30 bg-background/80 backdrop-blur-md border-b border-border/40 -mx-4 px-4 sm:-mx-6 sm:px-6">
      <div className="flex items-center gap-1 overflow-x-auto py-2.5 scrollbar-hide">
        {tabs.map((tab) => {
          const Icon = TAB_ICONS[tab.id] || LayoutDashboard;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl text-[13px] font-medium whitespace-nowrap transition-colors ${
                isActive
                  ? "bg-foreground/[0.07] text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
              }`}
            >
              <Icon className="size-4 shrink-0" strokeWidth={1.7} />
              {tab.label}
              {tab.id === "domains" && domainsAttention && (
                <span
                  className="size-1.5 rounded-full bg-warning-solid"
                  aria-label="Routing needs attention"
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
