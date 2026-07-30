"use client";

import React, { useState, useEffect, useRef } from "react";
import { Search } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import { ProjectFilter } from "./ProjectFilter";
import type { Project } from "../types";

interface DeploymentsFiltersProps {
  filter: "all" | "success" | "failed" | "building" | "pending" | "canceled";
  searchQuery: string;
  selectedProjectId: string | "all";
  projects: Project[];
  onFilterChange: (filter: "all" | "success" | "failed" | "building" | "pending" | "canceled") => void;
  onSearchChange: (query: string) => void;
  onProjectChange: (projectId: string | "all") => void;
  isProject: boolean;
}

const FILTERS = [
  { value: "all" },
  { value: "success" },
  { value: "failed" },
  { value: "building" },
  { value: "canceled" },
] as const;

export const DeploymentsFilters: React.FC<DeploymentsFiltersProps> = React.memo(({
  filter,
  searchQuery,
  selectedProjectId,
  projects,
  onFilterChange,
  onSearchChange,
  onProjectChange,
  isProject,
}) => {
  const { t } = useI18n();
  const [localSearchQuery, setLocalSearchQuery] = useState(searchQuery);
  const debounceTimeout = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    setLocalSearchQuery(searchQuery);
  }, [searchQuery]);

  const handleSearchChange = (value: string) => {
    setLocalSearchQuery(value);
    if (debounceTimeout.current) clearTimeout(debounceTimeout.current);
    debounceTimeout.current = setTimeout(() => onSearchChange(value), 300);
  };

  useEffect(() => {
    return () => {
      if (debounceTimeout.current) clearTimeout(debounceTimeout.current);
    };
  }, []);

  return (
    // ONE row from `sm` up: search grows, the status switch sits beside it instead
    // of below. Wraps (rather than squashing) when a project filter is also present
    // and the viewport is tight; stacks on mobile.
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="relative w-full sm:flex-1 sm:min-w-[220px]">
        <Search className="absolute start-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          placeholder={t.deployments.filters.searchPlaceholder}
          value={localSearchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="h-10 w-full rounded-xl border border-border/50 bg-card ps-10 pe-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/20 transition-all"
        />
      </div>
      {!isProject && (
        <ProjectFilter
          projects={projects}
          selectedProjectId={selectedProjectId}
          onProjectChange={onProjectChange}
        />
      )}

      {/* Status switch — same line as the search (shrink-0 so the input yields). */}
      <div className="inline-flex max-w-full shrink-0 flex-wrap items-center gap-1 rounded-xl bg-muted/35 p-1">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => onFilterChange(f.value)}
            className={`inline-flex h-8 items-center rounded-lg px-3.5 text-[12px] font-medium transition-colors ${
              filter === f.value
                ? "border border-border/60 bg-card text-foreground"
                : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
            }`}
          >
            {t.deployments.filters[f.value]}
          </button>
        ))}
      </div>
    </div>
  );
});

DeploymentsFilters.displayName = "DeploymentsFilters";
