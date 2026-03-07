"use client";

import React, { useState, useEffect, useRef } from "react";
import generateIcon from "@/utils/icons";
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

  // Update local state when parent changes search query
  useEffect(() => {
    setLocalSearchQuery(searchQuery);
  }, [searchQuery]);

  // Debounce search input - only call parent after 300ms of no typing
  const handleSearchChange = (value: string) => {
    setLocalSearchQuery(value);
    
    if (debounceTimeout.current) {
      clearTimeout(debounceTimeout.current);
    }
    
    debounceTimeout.current = setTimeout(() => {
      onSearchChange(value);
    }, 300);
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (debounceTimeout.current) {
        clearTimeout(debounceTimeout.current);
      }
    };
  }, []);

  return (
    <div className="bg-white rounded-[20px] sm:rounded-full p-4 sm:p-5">
      <div className="flex flex-col xl:flex-row gap-4 items-start xl:items-center justify-between">
        {/* Left: Status Filters + Project Filter */}
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap w-full xl:w-auto">
          {isProject ?
            <div className="flex items-center gap-2">
              {generateIcon('filter-80-1658432731.png', 24, 'rgba(0, 0, 0, 0.25)', { marginRight: '3px' })}
              <div className="divider h-4 bg-black/10 w-[1px]"></div>
            </div> :
            <ProjectFilter
              projects={projects}
              selectedProjectId={selectedProjectId}
              onProjectChange={onProjectChange}
            />}
          {/* Status Filters */}
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => onFilterChange(f.value)}
              className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded-full text-xs sm:text-sm font-semibold transition-all ${filter === f.value
                ? "bg-black text-white shadow-md"
                : "bg-black/5 text-black/70 hover:bg-black/10"
                }`}
            >
              {f.label}
            </button>
          ))}

          <div className="divider h-4 bg-black/10 w-[1px] hidden sm:block"></div>

        </div>

        {/* Right: Search Input */}
        <div className="relative w-full xl:w-80">
          {generateIcon('search-123-1658435124.png', 16, 'rgba(0, 0, 0, 0.5)', { position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' })}
          <input
            type="text"
            placeholder="Search commits, authors, projects..."
            value={localSearchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full pl-10 sm:pl-11 pr-4 py-2 sm:py-2.5 bg-black/5 border border-black/10 rounded-full text-xs sm:text-sm text-black placeholder:text-black/40 focus:outline-none focus:bg-white focus:border-black/20 focus: transition-all"
          />
        </div>
      </div>
    </div>
  );
});

DeploymentsFilters.displayName = 'DeploymentsFilters';
