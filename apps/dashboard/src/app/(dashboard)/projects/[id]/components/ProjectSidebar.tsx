"use client";

import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { usePlatform } from "@/context/PlatformContext";
import { formatDate } from "@/utils/date";
import { getProjectStatus, PROJECT_STATUS_META } from "@/utils/project-status";
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
} from "lucide-react";

const TAB_ICONS: Record<string, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  overview: LayoutDashboard,
  monitoring: Activity,
  services: Layers,
  domains: Globe,
  deployments: Rocket,
  source: GitBranch,
  runtime: Wrench,
  settings: Wrench,
  logs: ScrollText,
  advanced: AlertTriangle,
};

/** Desktop right-column navigation — matches LibrarySidebar / Home pattern */
export const ProjectSidebar = () => {
  const { projectData, projectNotFound, activeTab, tabs, setActiveTab, domain } = useProjectSettings();
  const { selfHosted, baseDomain } = usePlatform();
  const status = getProjectStatus(projectData as any);
  const meta = PROJECT_STATUS_META[status];
  const localPort = projectData.port || 3000;
  const localUrl = `localhost:${localPort}`;
  const slugDomain = projectData.slug && baseDomain ? `${projectData.slug}.${baseDomain}` : '';
  const displayUrl = domain || slugDomain || localUrl;
  const isLocal = !domain && !slugDomain && !selfHosted;

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
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
              Project
            </p>
            <h3 className="mt-2 truncate text-base font-semibold text-foreground">
              {projectData.name || "Untitled Project"}
            </h3>
          </div>
          <span className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${meta.badge}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
            {meta.label}
          </span>
        </div>

        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-muted-foreground">{isLocal ? "Local" : "Production"}</span>
            <a
              href={isLocal ? `http://${displayUrl}` : `https://${displayUrl}`}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-sm font-medium text-foreground hover:text-primary transition-colors"
            >
              {displayUrl}
            </a>
          </div>
          {projectData.last_deployed && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-muted-foreground">Last Deploy</span>
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
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/** Mobile horizontal scroll tabs — rendered above content in left column */
export const ProjectMobileTabs = () => {
  const { projectData, projectNotFound, activeTab, tabs, setActiveTab } = useProjectSettings();

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
            </button>
          );
        })}
      </div>
    </div>
  );
};
