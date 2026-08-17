/**
 * Operator release-recipe presets. Shared by the wizard (fills the form)
 * and the planner (path prefixes / lock files). Not a second store —
 * applying a preset writes `project.mountedRelease`.
 */

export const RELEASE_RECIPE_VERSION = 1 as const;

export const RELEASE_PRESET_IDS = ["laravel", "next-static", "node", "compose"] as const;
export type ReleasePresetId = (typeof RELEASE_PRESET_IDS)[number];

export type ReleaseBuildMode = "prebuilt" | "server" | "upload";
export type RuntimeInstall = "image" | "dockerfile" | "compose";

export type ReleasePersistHint = {
  id: "database" | "storage" | "uploads" | "cache";
  label: string;
  path: string;
};

export type ReleasePathPrefix = { key: string; prefixes: string[] };

export type ReleasePreset = {
  id: ReleasePresetId;
  label: string;
  description: string;
  buildMode: ReleaseBuildMode;
  runtimeInstall: RuntimeInstall;
  containerPath: string;
  sharedPaths: string[];
  persistHints: ReleasePersistHint[];
  prepareCommand?: string;
  reloadCommand?: string;
  healthPath: string;
  phases: string[];
  pathPrefixes?: ReleasePathPrefix[];
  lockFiles?: string[];
  builderCachePaths?: string[];
};

/** Fields a preset writes onto `project.mountedRelease`. */
export type ReleasePresetFill = {
  enabled: true;
  preset: ReleasePresetId;
  buildMode: ReleaseBuildMode;
  runtimeInstall: RuntimeInstall;
  containerPath: string;
  sharedPaths: string[];
  prepareCommand?: string;
  reloadCommand?: string;
  healthPath: string;
  builderCachePaths?: string[];
};

export const RELEASE_PRESETS: Record<ReleasePresetId, ReleasePreset> = {
  laravel: {
    id: "laravel",
    label: "Laravel",
    description:
      "PHP code release. Compiled assets stay in Git. Composer only when composer.lock changes.",
    buildMode: "prebuilt",
    runtimeInstall: "dockerfile",
    containerPath: "/srv/openship-app",
    sharedPaths: ["storage", "bootstrap/cache"],
    persistHints: [
      { id: "storage", label: "Storage", path: "storage" },
      { id: "cache", label: "Bootstrap cache", path: "bootstrap/cache" },
      { id: "database", label: "SQLite", path: "database/database.sqlite" },
    ],
    prepareCommand: "php artisan migrate --force && php artisan optimize",
    healthPath: "/up",
    phases: ["migrate --force", "optimize", "reload"],
    pathPrefixes: [
      { key: "staff", prefixes: ["apps/staff"] },
      { key: "public", prefixes: ["apps/public"] },
    ],
    lockFiles: ["composer.lock"],
  },
  "next-static": {
    id: "next-static",
    label: "Static Next",
    description: "Git-prebuilt static export. Health at /. No prepare step.",
    buildMode: "prebuilt",
    runtimeInstall: "image",
    containerPath: "/srv/openship-app",
    sharedPaths: [],
    persistHints: [],
    healthPath: "/",
    phases: [],
  },
  node: {
    id: "node",
    label: "Node",
    description: "Prepare on the server (npm ci && npm run build), or upload a local artifact.",
    buildMode: "server",
    runtimeInstall: "dockerfile",
    containerPath: "/srv/openship-app",
    sharedPaths: [],
    persistHints: [{ id: "uploads", label: "Uploads", path: "uploads" }],
    prepareCommand: "npm ci && npm run build",
    healthPath: "/",
    phases: ["prepare", "reload"],
    builderCachePaths: ["node_modules", ".npm"],
  },
  compose: {
    id: "compose",
    label: "Compose",
    description:
      "Target a stable compose service. Dockerfile or compose changes rebuild the runtime.",
    buildMode: "prebuilt",
    runtimeInstall: "compose",
    containerPath: "/srv/openship-app",
    sharedPaths: [],
    persistHints: [
      { id: "database", label: "Database", path: "database" },
      { id: "storage", label: "Storage", path: "storage" },
      { id: "uploads", label: "Uploads", path: "uploads" },
    ],
    healthPath: "/",
    phases: [],
  },
};

const STACK_PRESET: Record<string, ReleasePresetId> = {
  laravel: "laravel",
  nextjs: "next-static",
  node: "node",
  express: "node",
  "docker-compose": "compose",
};

export function isReleasePresetId(value: string | null | undefined): value is ReleasePresetId {
  return Boolean(value && (RELEASE_PRESET_IDS as readonly string[]).includes(value));
}

export function presetForStack(framework?: string | null): ReleasePresetId | undefined {
  if (!framework) return undefined;
  return STACK_PRESET[framework.trim().toLowerCase()];
}

export function applyReleasePreset(id: ReleasePresetId): ReleasePresetFill {
  const preset = RELEASE_PRESETS[id];
  return {
    enabled: true,
    preset: preset.id,
    buildMode: preset.buildMode,
    runtimeInstall: preset.runtimeInstall,
    containerPath: preset.containerPath,
    sharedPaths: [...preset.sharedPaths],
    prepareCommand: preset.prepareCommand,
    reloadCommand: preset.reloadCommand,
    healthPath: preset.healthPath,
    builderCachePaths: preset.builderCachePaths ? [...preset.builderCachePaths] : undefined,
  };
}

export function prefixesFromPreset(preset?: string | null): ReleasePathPrefix[] | undefined {
  if (!isReleasePresetId(preset)) return undefined;
  const prefixes = RELEASE_PRESETS[preset].pathPrefixes;
  return prefixes?.length ? prefixes : undefined;
}
