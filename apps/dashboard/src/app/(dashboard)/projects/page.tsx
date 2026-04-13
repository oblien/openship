"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { Project } from "@/constants/mock";
import ProjectCard from "./components/ProjectCard";
import EmptyState from "@/components/overview/EmptyState";
import { projectsApi } from "@/lib/api";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n-provider";
import { Plus, Search } from "lucide-react";
import { PageContainer } from "@/components/ui/PageContainer";

export default function ProjectsPage() {
  const { t } = useI18n();
  const [projects, setProjects] = useState<Project[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();
  const isLoadingRef = useRef(false);

  useEffect(() => {
    const fetchProjects = async () => {
      if (isLoadingRef.current) return;
      isLoadingRef.current = true;
      setIsLoading(true);
      try {
        const response = await projectsApi.getHome();
        if (response.success && Array.isArray(response.projects)) {
          setProjects(response.projects);
        }
      } catch (error) {
        console.error("Error fetching projects:", error);
      } finally {
        setIsLoading(false);
        isLoadingRef.current = false;
      }
    };
    fetchProjects();
    return () => { isLoadingRef.current = false; };
  }, []);

  const filteredProjects = projects.filter((p) => {
    const q = searchQuery.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      p.slug.toLowerCase().includes(q) ||
      p.framework.toLowerCase().includes(q)
    );
  });

  return (
    <PageContainer outerClassName="pb-20">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
              {t.dashboard.pages.projects.title}
            </h1>
            <p className="text-sm text-muted-foreground/70 mt-1">
              {isLoading ? "Loading..." : `${projects.length} project${projects.length !== 1 ? "s" : ""}`}
            </p>
          </div>
          <Link
            href="/library"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium transition-all hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 w-full sm:w-auto justify-center"
          >
            <Plus className="size-4" />
            <span>{t.dashboard.pages.projects.createButton}</span>
          </Link>
        </div>

        {isLoading ? (
          <div className="bg-card rounded-2xl border border-border/50">
            <div className="divide-y divide-border/50">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="px-5 py-4 flex items-center gap-4 animate-pulse">
                  <div className="w-10 h-10 bg-muted rounded-xl" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-muted rounded-lg w-32" />
                    <div className="h-3 bg-muted/60 rounded-lg w-48" />
                  </div>
                  <div className="h-6 bg-muted/60 rounded-full w-16" />
                </div>
              ))}
            </div>
          </div>
        ) : projects.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {/* Search */}
            {projects.length > 3 && (
              <div className="mb-4">
                <div className="relative max-w-md">
                  <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                  <input
                    type="text"
                    placeholder={t.dashboard.pages.projects.searchPlaceholder}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 bg-card border border-border/50 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/20 transition-all text-foreground placeholder:text-muted-foreground"
                  />
                </div>
              </div>
            )}

            {/* Project List */}
            <div className="bg-card rounded-2xl border border-border/50 divide-y divide-border/50">
              {filteredProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                />
              ))}
            </div>

            {/* No Results */}
            {filteredProjects.length === 0 && searchQuery && (
              <div className="bg-card rounded-2xl border border-border/50 py-16 text-center mt-4">
                <p className="text-sm text-muted-foreground">
                  {t.dashboard.pages.projects.noResultsFound.replace("{query}", searchQuery)}
                </p>
              </div>
            )}
          </>
        )}
    </PageContainer>
  );
}
