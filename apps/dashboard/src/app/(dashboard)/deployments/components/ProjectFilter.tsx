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
        className="flex items-center gap-2 px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm font-medium text-foreground/70 hover:bg-muted hover:text-foreground transition-all min-w-[150px] justify-between"
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
        <div className="absolute top-full left-0 mt-2 w-72 bg-popover border border-border/50 rounded-xl shadow-lg overflow-hidden z-50 max-h-96 overflow-y-auto">
          {/* All Projects Option */}
          <button
            onClick={() => {
              onProjectChange("all");
              setIsOpen(false);
            }}
            className={`w-full px-4 py-3 text-left text-sm transition-colors flex items-center gap-3 ${
              selectedProjectId === "all"
                ? "bg-primary/10 text-primary font-semibold"
                : "text-foreground/70 hover:bg-muted"
            }`}
          >
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
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
              className={`w-full px-4 py-3 text-left text-sm transition-colors flex items-center gap-3 ${
                selectedProjectId === project.id
                  ? "bg-primary/10 text-primary font-semibold"
                  : "text-foreground/70 hover:bg-muted"
              }`}
            >
              <div className="w-8 h-8 rounded-lg bg-muted border border-border/50 flex items-center justify-center flex-shrink-0">
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

