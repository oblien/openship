import React, { useState } from "react";
import { STACKS, STACK_ICONS, type StackId, type StackCategory as CoreStackCategory } from "@repo/core";

export type StackCategory = CoreStackCategory;

export interface FrameworkConfig {
  id: StackId;
  name: string;
  category: StackCategory;
  options: {
    buildCommand: string;
    installCommand: string;
    outputDirectory: string;
    isStatic?: boolean;
  };
  icon: (color: string) => React.ReactNode;
}

// ─── Icon rendering (uses STACK_ICONS from core as source of truth) ─────────

const StackIconImg: React.FC<{ name: string; url: string }> = ({ name, url }) => {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="w-full h-full rounded bg-muted flex items-center justify-center text-[10px] font-bold text-muted-foreground">
        {name.charAt(0)}
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={name}
      className="w-full h-full object-contain"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
};

function makeIcon(stackId: StackId) {
  const url = STACK_ICONS[stackId];
  if (!url) {
    return (_color: string) => (
      <div className="w-full h-full rounded bg-muted flex items-center justify-center text-[10px] font-bold text-muted-foreground">
        {STACKS[stackId].name.charAt(0)}
      </div>
    );
  }

  return (_color: string) => (
    <StackIconImg url={url} name={STACKS[stackId].name} />
  );
}

// ─── Categories shown in the UI tabs ────────────────────────────────────────

export const stackCategories: { id: StackCategory; label: string }[] = [
  { id: "frontend", label: "Frontend" },
  { id: "backend", label: "Backend" },
  { id: "fullstack", label: "Fullstack" },
  { id: "static", label: "Static" },
];

// ─── App-only stacks (excludes docker, services, unknown) ──────────────────

const EXCLUDED_STACKS = new Set<string>(["unknown", "docker", "docker-compose"]);

export const frameworks: FrameworkConfig[] = (Object.entries(STACKS) as [StackId, (typeof STACKS)[StackId]][])
  .filter(([id, def]) => !EXCLUDED_STACKS.has(id) && def.category !== "docker" && def.category !== "services")
  .map(([id, def]) => ({
    id,
    name: def.name,
    category: def.category,
    options: {
      buildCommand: def.defaultBuildCommand,
      installCommand: "",
      outputDirectory: def.outputDirectory,
      isStatic: def.category === "static" || (def.category === "frontend" && !def.defaultStartCommand),
    },
    icon: makeIcon(id),
  }));

/**
 * Get framework configuration by ID
 */
export const getFrameworkConfig = (frameworkId: string): FrameworkConfig => {
  return frameworks.find(fw => fw.id === frameworkId) || frameworks.find(fw => fw.id === "static")!;
};

