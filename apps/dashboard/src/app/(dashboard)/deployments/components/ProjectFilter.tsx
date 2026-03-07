"use client";

import React, { useState, useRef, useEffect } from "react";
import { generateIcon } from "@/utils/icons";
import { ChevronDown } from "lucide-react";
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
        className="flex items-center gap-2 px-4 py-2.5 bg-white border border-black/10 rounded-full text-sm font-medium text-black/70 hover:bg-black/5 hover:border-black/20 transition-all min-w-[150px] justify-between"
      >
        <div className="flex items-center gap-2">
          {generateIcon('layers-363-1658238246.png', 18, 'rgba(0, 0, 0, 0.5)')}
          <span className="truncate">{selectedProject.name}</span>
        </div>
        <ChevronDown 
          className={`w-4 h-4 text-black/40 transition-transform ${isOpen ? 'rotate-180' : ''}`} 
        />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-2 w-72 bg-white border border-black/10 rounded-2xl shadow-lg overflow-hidden z-50 max-h-96 overflow-y-auto">
          {/* All Projects Option */}
          <button
            onClick={() => {
              onProjectChange("all");
              setIsOpen(false);
            }}
            className={`w-full px-4 py-3 text-left text-sm transition-colors flex items-center gap-3 ${
              selectedProjectId === "all"
                ? "bg-indigo-50 text-indigo-700 font-semibold"
                : "text-black/70 hover:bg-black/5"
            }`}
          >
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center flex-shrink-0">
              {generateIcon('layers-363-1658238246.png', 16, 'rgb(255, 255, 255)')}
            </div>
            <span>All Projects</span>
            {selectedProjectId === "all" && (
              <div className="ml-auto">
                {generateIcon('checkmark-72-1658234612.png', 16, 'var(--color-indigo-600)')}
              </div>
            )}
          </button>

          {/* Divider */}
          <div className="h-px bg-black/5 mx-2" />

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
                  ? "bg-indigo-50 text-indigo-700 font-semibold"
                  : "text-black/70 hover:bg-black/5"
              }`}
            >
              <div className="w-8 h-8 rounded-lg bg-black/5 border border-black/10 flex items-center justify-center flex-shrink-0">
                {generateIcon('layers-363-1658238246.png', 16, 'rgba(0, 0, 0, 0.5)')}
              </div>
              <span className="truncate flex-1">{project.name}</span>
              {selectedProjectId === project.id && (
                <div className="flex-shrink-0">
                  {generateIcon('checkmark-72-1658234612.png', 16, 'var(--color-indigo-600)')}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

