"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { type ReactNode } from "react";
import type { Project } from "@/constants/mock";
import { useI18n } from "@/components/i18n-provider";
import type { Dictionary } from "@/i18n";

/**
 * Filter projects by where they're deployed: all, Openship Cloud, a specific
 * server (by name), or local. Mirrors the hosting label logic in ProjectCard
 * (deployTarget: "cloud" | "server" | "local", serverName for servers).
 */
export type ProjectFilter =
  | { kind: "all" }
  | { kind: "cloud" }
  | { kind: "local" }
  | { kind: "server"; name: string };

/** Stable string key for a filter (used for active-state comparison + React keys). */
export function projectFilterKey(filter: ProjectFilter): string {
  return filter.kind === "server" ? `server:${filter.name}` : filter.kind;
}

/** Does a project belong to the given filter? */
export function projectMatchesFilter(project: Project, filter: ProjectFilter): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "cloud":
      return project.deployTarget === "cloud";
    case "local":
      return project.deployTarget === "local";
    case "server":
      return project.deployTarget === "server" && (project.serverName || "Server") === filter.name;
  }
}

export interface ProjectFilterOption {
  key: string;
  filter: ProjectFilter;
  label: string;
  icon: ReactNode;
  count: number;
}

/**
 * Derive the available filters from the loaded projects: always "All", then
 * Cloud / each distinct server / Local — but only those that actually have
 * projects. The page uses the option count to decide whether the sidebar is
 * worth showing (≥2 real groups).
 */
export function buildProjectFilterOptions(projects: Project[], t: Dictionary): ProjectFilterOption[] {
  let cloud = 0;
  let local = 0;
  const servers = new Map<string, number>();

  for (const p of projects) {
    if (p.deployTarget === "cloud") cloud++;
    else if (p.deployTarget === "local") local++;
    else if (p.deployTarget === "server") {
      const name = p.serverName || t.projects.hosting.server;
      servers.set(name, (servers.get(name) ?? 0) + 1);
    }
  }

  const options: ProjectFilterOption[] = [
    {
      key: "all",
      filter: { kind: "all" },
      label: t.projects.filters.allProjects,
      icon: <UiIcon name="grid" className="size-4" />,
      count: projects.length,
    },
  ];

  if (cloud > 0) {
    options.push({
      key: "cloud",
      filter: { kind: "cloud" },
      label: t.projects.filters.cloud,
      icon: <UiIcon name="cloud" className="size-4" />,
      count: cloud,
    });
  }

  for (const [name, count] of [...servers.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    options.push({
      key: `server:${name}`,
      filter: { kind: "server", name },
      label: name,
      icon: <UiIcon name="server" className="size-4" />,
      count,
    });
  }

  if (local > 0) {
    options.push({
      key: "local",
      filter: { kind: "local" },
      label: t.projects.filters.local,
      icon: <UiIcon name="hard-drive" className="size-4" />,
      count: local,
    });
  }

  return options;
}

interface ProjectFiltersProps {
  options: ProjectFilterOption[];
  active: ProjectFilter;
  onChange: (filter: ProjectFilter) => void;
}

export function ProjectFilters({ options, active, onChange }: ProjectFiltersProps) {
  const { t } = useI18n();
  const activeKey = projectFilterKey(active);

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="px-5 py-4 border-b border-border/50">
        <h2 className="font-semibold text-foreground text-[15px]">{t.projects.filters.title}</h2>
        <p className="text-xs text-muted-foreground">{t.projects.filters.subtitle}</p>
      </div>
      <div className="p-2">
        {options.map((opt) => {
          const isActive = opt.key === activeKey;
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => onChange(opt.filter)}
              className={
                "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors " +
                (isActive
                  ? "bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")
              }
            >
              <span className={isActive ? "text-primary" : "text-muted-foreground"}>{opt.icon}</span>
              <span className="flex-1 text-start truncate">{opt.label}</span>
              <span className={"text-xs tabular-nums " + (isActive ? "text-foreground" : "text-muted-foreground/60")}>
                {opt.count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
