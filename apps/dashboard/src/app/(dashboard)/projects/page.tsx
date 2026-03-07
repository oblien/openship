"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { Project } from "@/constants/mock";
import ProjectCard from "./components/ProjectCard";
import EmptyState from "@/components/overview/EmptyState";
import ActivityChart from "@/components/overview/ActivityChart";
import { projectsApi } from "@/lib/api";
import { generateIcon } from "@/utils/icons";
import { useRouter } from "next/navigation";
import { SlidingToggle } from "@/components/ui/SlidingToggle";
import { Grid3x3, List } from "lucide-react";
import { SectionContainer } from "@/components/ui/SectionContainer";
import { useI18n } from "@/components/i18n-provider";

export default function DeploymentDashboard() {
  const { t } = useI18n();
  const [projects, setProjects] = useState<Project[]>([]);
  const [pinnedProjects, setPinnedProjects] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [viewMode, setViewMode] = useState<"grid" | "list">("list");
  const [numbers, setNumbers] = useState<any>({});
  const router = useRouter();
  const isLoadingRef = useRef<boolean>(false);
  // Fetch projects from API
  
  useEffect(() => {
    const fetchProjects = async () => {
      try {
        if(isLoadingRef.current) return;
        isLoadingRef.current = true;
        setIsLoadingProjects(true);
        const response = await projectsApi.getHome();

        setNumbers(response.numbers || {});

        if (response.success && Array.isArray(response.projects)) {
          // Map API response to Project interface
          const mappedProjects: Project[] = response.projects.map((project: any, index: number) => {
            const hasRepo = project.owner && project.repo;
            const repoSlug = hasRepo ? `${project.owner}/${project.repo}` : '';

            return {
              id: project.id,
              name: project.name || 'Unnamed Project',
              description: project.commit_message || project.description || `Production deployment`,
              framework: project.stack || 'unknown',
              url: `https://${project.domain}`,
              status: project.active ? "live" : "paused",
              lastDeployed: project.updated_at || project.created_at,
              domain: project.domain,
              isCustomDomain: !project.domain.endsWith('.obl.ee'),
              deploymentCount: 1,
              visitors: '0',
              repo: repoSlug,
            };
          });
          setProjects(mappedProjects);
        }
      } catch (error) {
        console.error('Error fetching projects:', error);
      } finally {
        setIsLoadingProjects(false);
        isLoadingRef.current = false;
      }
    };

    fetchProjects();

    // Load pinned projects from localStorage
    const stored = localStorage.getItem('pinnedProjects');
    if (stored) {
      setPinnedProjects(JSON.parse(stored));
    }

    return () => {
      isLoadingRef.current = false;
    };
  }, []);

  // Toggle pin project
  const togglePin = (projectId: string) => {
    setPinnedProjects(prev => {
      const newPinned = prev.includes(projectId)
        ? prev.filter(id => id !== projectId)
        : [...prev, projectId];
      localStorage.setItem('pinnedProjects', JSON.stringify(newPinned));
      return newPinned;
    });
  };

  const filteredProjects = projects.filter((project) =>
    project.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    project.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
    project.framework.toLowerCase().includes(searchQuery.toLowerCase())
  ) || [];

  const pinnedProjectsList = filteredProjects.filter(p => pinnedProjects.includes(p.id.toString()));
  const unpinnedProjectsList = filteredProjects.filter(p => !pinnedProjects.includes(p.id.toString()));

  const stats = [
    {
      icon: 'layers-363-1658238246.png',
      label: t.dashboard.pages.projects.stats.totalProjects,
      value: numbers.total_active_projects,
      onClick: () => {
        router.push('/deployments');
      }
    },
    {
      icon: 'check%20circle-68-1658234612.png',
      label: t.dashboard.pages.projects.stats.liveNow,
      value: numbers.total_active_projects,
      onClick: () => {
        router.push('/deployments');
      }
    },
    {
      icon: 'flash-109-1689918656.png',
      label: t.dashboard.pages.projects.stats.avgPerDay,
      value: (numbers.total_deployments / 7).toFixed(1),
      onClick: () => {
        router.push('/deployments');
      }
    },
    {
      icon: 'check%20circle-68-1658234612.png',
      label: t.dashboard.pages.projects.stats.successRate,
      value: `${numbers.total_success_deployments}/${numbers.total_deployments}`,
      onClick: () => {
        router.push('/deployments');
      }
    }
  ]

  return (
    <div className="min-h-screen bg-background pb-70">
      <SectionContainer>
        {/* Header */}
        <div className="mb-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
                {t.dashboard.pages.projects.title}
              </h1>
              <p className="text-sm text-muted-foreground/70 mt-1">
                {t.dashboard.pages.projects.description}
              </p>
            </div>
            <Link
              href="/library"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium transition-all hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 w-full sm:w-auto justify-center"
            >
              {generateIcon('story%20add-152-1658436130.png', 18, 'hsl(var(--primary-foreground))')}
              <span>{t.dashboard.pages.projects.createButton}</span>
            </Link>
          </div>
        </div>

        {isLoadingProjects ? (
          <div className="bg-card rounded-xl border border-border/50">
            <div className="divide-y divide-border/50">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="px-5 py-4 flex items-center gap-4 animate-pulse">
                  <div className="w-10 h-10 bg-muted rounded-xl"></div>
                  <div className="flex-1">
                    <div className="h-4 bg-muted rounded-lg w-32 mb-2"></div>
                    <div className="h-3 bg-muted/60 rounded-lg w-48"></div>
                  </div>
                  <div className="h-6 bg-muted/60 rounded-full w-16"></div>
                </div>
              ))}
            </div>
          </div>
        ) : projects.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {/* Stats Overview - Stats Left, Chart Right */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 mb-6">
              {/* Left - Quick Stats (4 columns) */}
              <div className="lg:col-span-4">
                <div className="bg-card rounded-xl border border-border/50 p-4 h-full flex flex-col justify-between gap-2">
                  {stats.map((stat, index) => (
                    <div
                      key={index}
                      onClick={() => stat.onClick}
                      className="flex items-center justify-between py-2.5 px-3 rounded-lg bg-muted/40 hover:bg-muted/60 cursor-pointer transition-colors">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
                          {generateIcon(stat.icon, 16, 'var(--th-text-muted)')}
                        </div>
                        <span className="text-xs text-muted-foreground font-medium">{stat.label}</span>
                      </div>
                      <p className="text-base font-semibold text-foreground">{stat.value}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Right - Activity Chart (8 columns) */}
              <div className="lg:col-span-8">
                <ActivityChart numbers={numbers} projects={projects} />
              </div>
            </div>

            {/* Search Bar and View Toggle */}
            <div className="bg-card rounded-xl border border-border/50 p-4 mb-6">
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                <div className="relative flex-1">
                  <div className="absolute left-4 top-1/2 transform -translate-y-1/2 pointer-events-none">
                    {generateIcon('search-123-1658435124.png', 18, 'var(--th-text-muted)')}
                  </div>
                  <input
                    type="text"
                    placeholder={t.dashboard.pages.projects.searchPlaceholder}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-11 pr-4 py-2.5 bg-muted/40 border border-transparent rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/20 focus:bg-card transition-all text-foreground placeholder:text-muted-foreground"
                  />
                </div>

                {/* View Toggle */}
                <SlidingToggle
                  options={[
                    {
                      value: 'list',
                      icon: <List className="w-5 h-5" />,
                    },
                    {
                      value: 'grid',
                      icon: <Grid3x3 className="w-5 h-5" />,
                    },
                  ]}
                  value={viewMode}
                  onChange={(value) => setViewMode(value as "grid" | "list")}
                  variant="rounded"
                  selectedBg="bg-primary"
                  selectedTextColor="text-primary-foreground"
                  unselectedTextColor="text-muted-foreground"
                  backgroundColor="bg-card"
                  size="lg"
                />
              </div>
            </div>

            {/* Pinned Projects Section */}
            {pinnedProjectsList.length > 0 && (
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                  {generateIcon('pin-210-1658433759.png', 16, 'var(--th-text-muted)')}
                  <h2 className="text-sm font-medium text-foreground/80">
                    {t.dashboard.pages.projects.pinnedProjects}
                  </h2>
                  <span className="text-xs text-muted-foreground">
                    ({pinnedProjectsList.length})
                  </span>
                </div>
                <div className={viewMode === "list" ? "space-y-4" : "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-5"}>
                  {pinnedProjectsList.map((project) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      viewMode={viewMode}
                      isPinned={true}
                      onTogglePin={() => togglePin(project.id.toString())}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* All Projects Section */}
            {unpinnedProjectsList.length > 0 && (
              <div>
                {pinnedProjectsList.length > 0 && (
                  <div className="flex items-center gap-2 mb-3">
                    <h2 className="text-sm font-medium text-foreground/80">
                      {t.dashboard.pages.projects.otherProjects}
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      ({unpinnedProjectsList.length})
                    </span>
                  </div>
                )}
                <div className={viewMode === "list" ? "space-y-4" : "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-5"}>
                  {unpinnedProjectsList.map((project) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      viewMode={viewMode}
                      isPinned={false}
                      onTogglePin={() => togglePin(project.id.toString())}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* No Results State */}
            {filteredProjects.length === 0 && (
              <div className="bg-card rounded-xl border border-border/50 py-16 text-center">
                <div className="flex flex-col items-center">
                  <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center mb-4">
                    {generateIcon('search-103-1658433844.png', 24, 'var(--th-text-muted)')}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t.dashboard.pages.projects.noResultsFound.replace('{query}', searchQuery)}
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </SectionContainer>
    </div>
  );
}
