"use client";

import React, { useState, useRef, useEffect } from "react";
import { ChevronDown, Layers, Check } from "lucide-react";
import type { Project } from "../types";

interface ProjectFilterProps {
  projects: Project[];
  selectedProjectId: string | "all";
  onProjectChange: (projectId: string | "all") => void;
}

export const ProjectFilter: React.FC<ProjectFilterProps> = ({
  projects,
  selectedProjectId,
  onProjectChange,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const selectedProject = selectedProjectId === "all" 
    ? { id: "all", name: "All Projects" }
    : projects.find(p => p.id === selectedProjectId) || { id: "all", name: "All Projects" };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex h-10 min-w-[170px] items-center justify-between gap-2 rounded-xl border border-border bg-background px-3.5 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted/25"
      >
        <div className="flex items-center gap-2">
          <Layers className="size-4 text-muted-foreground" />
          <span className="truncate">{selectedProject.name}</span>
        </div>
        <ChevronDown 
          className={`w-4 h-4 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} 
        />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 z-50 mt-2 max-h-96 w-72 overflow-y-auto rounded-xl border border-border/50 bg-popover overflow-hidden">
          {/* All Projects Option */}
          <button
            onClick={() => {
              onProjectChange("all");
              setIsOpen(false);
            }}
            className={`flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors ${
              selectedProjectId === "all"
                ? "bg-primary/10 text-primary font-semibold"
                : "text-foreground/80 hover:bg-muted/40"
            }`}
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Layers className="size-4 text-primary" />
            </div>
            <span>All Projects</span>
            {selectedProjectId === "all" && (
              <div className="ml-auto">
                <Check className="size-4 text-primary" />
              </div>
            )}
          </button>

          {/* Divider */}
          <div className="h-px bg-border/50 mx-2" />

          {/* Individual Projects */}
          {projects.map((project) => (
            <button
              key={project.id}
              onClick={() => {
                onProjectChange(project.id);
                setIsOpen(false);
              }}
              className={`flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors ${
                selectedProjectId === project.id
                  ? "bg-primary/10 text-primary font-semibold"
                  : "text-foreground/80 hover:bg-muted/40"
              }`}
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-muted/40">
                <Layers className="size-4 text-muted-foreground" />
              </div>
              <span className="truncate flex-1">{project.name}</span>
              {selectedProjectId === project.id && (
                <div className="flex-shrink-0">
                  <Check className="size-4 text-primary" />
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

