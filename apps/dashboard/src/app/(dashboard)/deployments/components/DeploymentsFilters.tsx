"use client";

import React, { useState, useEffect, useRef } from "react";
import { Search } from "lucide-react";
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
  { value: "all", label: "All" },
  { value: "success", label: "Success" },
  { value: "failed", label: "Failed" },
  { value: "building", label: "Building" },
  { value: "canceled", label: "Canceled" },
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
    <div className="bg-card rounded-2xl border border-border/50 px-4 py-4 space-y-4">
      {/* Row 1: Search + Project filter */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search deployments..."
            value={localSearchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="h-10 w-full rounded-xl border border-border bg-background pl-10 pr-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring transition-colors"
          />
        </div>
        {!isProject && (
          <ProjectFilter
            projects={projects}
            selectedProjectId={selectedProjectId}
            onProjectChange={onProjectChange}
          />
        )}
      </div>

      {/* Row 2: Status filters */}
      <div className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-xl bg-muted/35 p-1">
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
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
});

DeploymentsFilters.displayName = "DeploymentsFilters";
