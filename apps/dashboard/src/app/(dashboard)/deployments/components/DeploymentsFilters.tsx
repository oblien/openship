"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useState, useEffect, useRef } from "react";
import { useI18n } from "@/components/i18n-provider";
import { Input } from "@/components/ui/input";
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
    if (debounceTimeout.current) clearTimeout(debounceTimeout.current);
    setLocalSearchQuery(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    const cancelSearch = () => {
      if (debounceTimeout.current) clearTimeout(debounceTimeout.current);
      setLocalSearchQuery(searchQuery);
    };
    window.addEventListener("popstate", cancelSearch);
    return () => window.removeEventListener("popstate", cancelSearch);
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
        <UiIcon name="search" className="absolute start-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
        <Input
          variant="filled"
          type="text"
          placeholder={t.deployments.filters.searchPlaceholder}
          aria-label={t.deployments.filters.searchPlaceholder}
          value={localSearchQuery}
          maxLength={200}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="h-10 bg-muted/60 ps-10 pe-4"
        />
      </div>
      {!isProject && (
        <ProjectFilter
          projects={projects}
          selectedProjectId={selectedProjectId}
          onProjectChange={onProjectChange}
        />
      )}

      {/* Status switch — same line as the search (shrink-0 so the input yields).
          Chips scroll horizontally instead of wrapping - on a narrow screen
          wrapping made the pill row jump to two ragged lines; a single
          scrollable row keeps the control's height constant. */}
      <div className="max-w-full shrink-0 overflow-x-auto scrollbar-hide">
        <div className="inline-flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => onFilterChange(f.value)}
              className={`inline-flex h-10 shrink-0 items-center rounded-lg px-4 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring ${
                filter === f.value
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {t.deployments.filters[f.value]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
});

DeploymentsFilters.displayName = "DeploymentsFilters";
