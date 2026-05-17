import { getBuildImage } from "@repo/core";
import {
  MANIFEST_FILES,
  detectPackageManager,
  detectStack,
  getBuildCommand,
  getInstallCommand,
  getStartCommand,
  type RepoFile,
  type StackResult,
} from "./stack-detector";
import { posix as pathPosix } from "node:path";

export interface RepoTreeEntry {
  path: string;
  type?: string;
}

export type ProjectRootSource = "root" | "vercel" | "workspace" | "discovered";

export interface ProjectRootSnapshotInput {
  rootDirectory: string;
  files: RepoFile[];
  packageJson?: Record<string, unknown>;
  fileContents?: Record<string, string>;
  source?: ProjectRootSource;
}

export interface ProjectRootSnapshot extends ProjectRootSnapshotInput {
  fileContents: Record<string, string>;
  source: ProjectRootSource;
  stack: StackResult;
}

export interface ProjectRootHint {
  rootDirectory: string;
  source: Exclude<ProjectRootSource, "root">;
}

const NESTED_APP_CATEGORIES = new Set(["frontend", "fullstack", "static"]);

const DISCOVERED_ROOT_MARKERS = new Set([
  "package.json",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "index.html",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "nuxt.config.js",
  "nuxt.config.ts",
  "nuxt.config.mjs",
  "svelte.config.js",
  "svelte.config.mjs",
  "astro.config.js",
  "astro.config.mjs",
  "astro.config.ts",
  "vite.config.js",
  "vite.config.ts",
  "vite.config.mjs",
  "angular.json",
  "gatsby-config.js",
  "gatsby-config.ts",
  "vue.config.js",
  "vue.config.ts",
  // Nx project marker — each Nx workspace project carries a project.json
  "project.json",
  ...MANIFEST_FILES.map((name) => name.toLowerCase()),
]);

const IGNORED_REPO_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".vercel",
  ".venv",
  "__pycache__",
  "build",
  "dist",
  "coverage",
  "target",
  "vendor",
]);

const APPISH_ROOT_SEGMENTS = new Set([
  "app",
  "apps",
  "frontend",
  "front",
  "web",
  "site",
  "www",
  "client",
  "dashboard",
  "admin",
]);

const LIBRARY_ROOT_SEGMENTS = new Set([
  "package",
  "packages",
  "lib",
  "libs",
  "shared",
  "common",
  "core",
  "utils",
  "components",
]);

const MAX_PROJECT_ROOT_HINTS = 24;

/**
 * Single source of truth for project-root selection heuristics. Tuning weights here
 * lets you reason about ranking without grepping through scoring functions.
 */
const CANDIDATE_WEIGHTS = {
  source: { vercel: 100, workspace: 60, discovered: 20, root: 0 },
  category: { fullstack: 30, frontend: 20, static: 10, backend: 0, generic: 0 },
  servicesProject: 16,
  hasBuildScript: 5,
  files: { "index.html": 6, public: 4, src: 2 },
  segments: {
    firstIsApps: 10,
    lastIsAppish: 8,
    firstIsLibrary: -8,
    shallowBonus: 1,
  },
} as const;

export function normalizeProjectRootDirectory(value?: string): string {
  const normalized = value
    ?.trim()
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");

  if (!normalized || normalized === ".") {
    return "";
  }

  return normalized.split(/[\\/]/).filter(Boolean).join("/");
}

function normalizeFileContents(fileContents?: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [name, content] of Object.entries(fileContents ?? {})) {
    normalized[name.toLowerCase()] = content;
  }

  return normalized;
}

export function isIgnoredRepoPath(value?: string): boolean {
  const normalized = normalizeProjectRootDirectory(value);
  if (!normalized) {
    return false;
  }

  return normalized.split("/").some((segment) => IGNORED_REPO_DIRS.has(segment.toLowerCase()));
}

function buildSnapshot(input: ProjectRootSnapshotInput): ProjectRootSnapshot {
  const fileContents = normalizeFileContents(input.fileContents);

  return {
    ...input,
    rootDirectory: normalizeProjectRootDirectory(input.rootDirectory),
    fileContents,
    source: input.source ?? "root",
    stack: detectStack(input.files, input.packageJson, fileContents),
  };
}

function sourcePriority(source: ProjectRootHint["source"]): number {
  switch (source) {
    case "vercel":
      return 4;
    case "workspace":
      return 3;
    case "discovered":
      return 2;
  }
}

function hasPackageJsonWorkspaces(packageJson?: Record<string, unknown>): boolean {
  const workspaces = packageJson?.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.some((value) => typeof value === "string" && value.trim().length > 0);
  }

  if (!workspaces || typeof workspaces !== "object") {
    return false;
  }

  const packages = (workspaces as { packages?: unknown }).packages;
  return Array.isArray(packages)
    ? packages.some((value) => typeof value === "string" && value.trim().length > 0)
    : false;
}

function getPackageJsonWorkspacePatterns(packageJson?: Record<string, unknown>): string[] {
  const workspaces = packageJson?.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  }

  if (!workspaces || typeof workspaces !== "object") {
    return [];
  }

  const packages = (workspaces as { packages?: unknown }).packages;
  return Array.isArray(packages)
    ? packages.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
}

function getPnpmWorkspacePatterns(pnpmWorkspaceContent?: string): string[] {
  if (!pnpmWorkspaceContent) {
    return [];
  }

  const patterns: string[] = [];
  let inPackagesBlock = false;

  for (const rawLine of pnpmWorkspaceContent.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line) {
      continue;
    }

    if (!inPackagesBlock) {
      if (/^packages\s*:\s*$/.test(line.trim())) {
        inPackagesBlock = true;
      }
      continue;
    }

    if (/^[A-Za-z0-9_-]+\s*:/.test(line.trim())) {
      break;
    }

    const match = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/);
    if (match) {
      patterns.push(match[1]);
    }
  }

  return patterns;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesWorkspacePattern(rootDirectory: string, pattern: string): boolean {
  const normalizedRoot = normalizeProjectRootDirectory(rootDirectory);
  const normalizedPattern = normalizeProjectRootDirectory(pattern);
  if (!normalizedRoot || !normalizedPattern) {
    return false;
  }

  const regex = new RegExp(`^${normalizedPattern
    .split("/")
    .map((segment) => {
      if (segment === "**") return ".+";
      if (segment === "*") return "[^/]+";
      return escapeRegex(segment);
    })
    .join("/")}$`);

  return regex.test(normalizedRoot);
}

/**
 * Rush monorepo: rush.json declares each project explicitly under projects[].projectFolder.
 */
function parseRushWorkspacePatterns(rushJsonContent?: string): string[] {
  if (!rushJsonContent) {
    return [];
  }

  try {
    const parsed = JSON.parse(rushJsonContent) as { projects?: unknown };
    const projects = Array.isArray(parsed.projects) ? parsed.projects : [];

    return projects
      .map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        const folder = (entry as { projectFolder?: unknown }).projectFolder;
        return typeof folder === "string" ? folder : "";
      })
      .filter((folder) => folder.trim().length > 0);
  } catch {
    return [];
  }
}

function getWorkspacePatterns(
  rootPackageJson?: Record<string, unknown>,
  rootFileContents?: Record<string, string>,
): string[] {
  const normalizedFileContents = normalizeFileContents(rootFileContents);
  return [
    ...getPackageJsonWorkspacePatterns(rootPackageJson),
    ...getPnpmWorkspacePatterns(normalizedFileContents["pnpm-workspace.yaml"]),
    ...parseRushWorkspacePatterns(normalizedFileContents["rush.json"]),
  ].map((pattern) => normalizeProjectRootDirectory(pattern)).filter(Boolean);
}

function preScoreHint(rootDirectory: string, source: ProjectRootHint["source"]): number {
  const normalized = normalizeProjectRootDirectory(rootDirectory);
  if (!normalized) {
    return sourcePriority(source) * 100;
  }

  const segments = normalized.split("/");
  const first = segments[0]?.toLowerCase() ?? "";
  const last = segments.at(-1)?.toLowerCase() ?? "";
  let score = sourcePriority(source) * 100;

  if (first === "apps") score += 20;
  if (APPISH_ROOT_SEGMENTS.has(last)) score += 12;
  if (LIBRARY_ROOT_SEGMENTS.has(first)) score -= 12;
  score -= segments.length;

  return score;
}

export function parseVercelRootDirectories(vercelConfig?: string): string[] {
  if (!vercelConfig) {
    return [];
  }

  try {
    const parsed = JSON.parse(vercelConfig) as {
      buildCommand?: unknown;
      outputDirectory?: unknown;
    };
    const directories = new Set<string>();
    const buildCommand = typeof parsed.buildCommand === "string" ? parsed.buildCommand : "";

    for (const match of buildCommand.matchAll(/(?:^|&&)\s*cd\s+['"]?([^'"&\s]+)['"]?/g)) {
      const candidate = normalizeProjectRootDirectory(match[1]);
      if (candidate) {
        directories.add(candidate);
      }
    }

    const outputDirectory = typeof parsed.outputDirectory === "string" ? parsed.outputDirectory : "";
    const outputRoot = normalizeProjectRootDirectory(pathPosix.dirname(outputDirectory));
    if (outputRoot) {
      directories.add(outputRoot);
    }

    return [...directories];
  } catch {
    return [];
  }
}

export function discoverProjectRootHints(
  treeEntries: RepoTreeEntry[],
  rootFileContents?: Record<string, string>,
  rootPackageJson?: Record<string, unknown>,
): ProjectRootHint[] {
  const hints = new Map<string, ProjectRootHint>();
  const workspacePatterns = getWorkspacePatterns(rootPackageJson, rootFileContents);
  const normalizedRootFileContents = normalizeFileContents(rootFileContents);

  for (const rootDirectory of parseVercelRootDirectories(normalizedRootFileContents["vercel.json"])) {
    hints.set(rootDirectory, { rootDirectory, source: "vercel" });
  }

  for (const entry of treeEntries) {
    const entryType = entry.type?.toLowerCase();
    if (entryType && entryType !== "file" && entryType !== "blob") {
      continue;
    }

    const normalizedPath = normalizeProjectRootDirectory(entry.path);
    if (!normalizedPath || isIgnoredRepoPath(normalizedPath)) {
      continue;
    }

    const baseName = pathPosix.basename(normalizedPath).toLowerCase();
    if (!DISCOVERED_ROOT_MARKERS.has(baseName)) {
      continue;
    }

    const rootDirectory = normalizeProjectRootDirectory(pathPosix.dirname(normalizedPath));
    if (!rootDirectory || isIgnoredRepoPath(rootDirectory)) {
      continue;
    }

    const source: ProjectRootHint["source"] = workspacePatterns.some((pattern) =>
      matchesWorkspacePattern(rootDirectory, pattern)
    )
      ? "workspace"
      : "discovered";

    const existing = hints.get(rootDirectory);
    if (!existing || sourcePriority(source) > sourcePriority(existing.source)) {
      hints.set(rootDirectory, { rootDirectory, source });
    }
  }

  const sortedHints = [...hints.values()]
    .sort((left, right) => preScoreHint(right.rootDirectory, right.source) - preScoreHint(left.rootDirectory, left.source))
  ;

  const preferredHints = sortedHints.filter((hint) => hint.source !== "discovered");
  const discoveredHints = sortedHints.filter((hint) => hint.source === "discovered");

  if (preferredHints.length >= MAX_PROJECT_ROOT_HINTS) {
    return preferredHints;
  }

  return [
    ...preferredHints,
    ...discoveredHints.slice(0, MAX_PROJECT_ROOT_HINTS - preferredHints.length),
  ];
}

export function collectPreferredRootHints(
  rootFiles: RepoFile[],
  rootFileContents?: Record<string, string>,
  rootPackageJson?: Record<string, unknown>,
): ProjectRootHint[] {
  return discoverProjectRootHints(
    rootFiles.map((file) => ({ path: file.name, type: file.type })),
    rootFileContents,
    rootPackageJson,
  );
}

function canPromoteNestedApp(root: ProjectRootSnapshot): boolean {
  return (
    root.stack.projectType === "app" &&
    (root.stack.category === "backend" ||
      root.stack.category === "generic" ||
      root.stack.stack === "node" ||
      root.stack.stack === "unknown")
  );
}

function isNestedProjectCandidate(candidate: ProjectRootSnapshot): boolean {
  if (!candidate.rootDirectory || candidate.stack.stack === "unknown") {
    return false;
  }

  if (candidate.stack.projectType === "services") {
    return true;
  }

  return (
    candidate.stack.projectType === "app" &&
    NESTED_APP_CATEGORIES.has(candidate.stack.category)
  );
}

function canExposeSingleAppAlternative(root: ProjectRootSnapshot): boolean {
  return root.stack.projectType === "services";
}

function isNestedSingleAppCandidate(candidate: ProjectRootSnapshot): boolean {
  if (!candidate.rootDirectory || candidate.stack.stack === "unknown") {
    return false;
  }

  return (
    candidate.stack.projectType === "app" &&
    NESTED_APP_CATEGORIES.has(candidate.stack.category)
  );
}

function hasRootWorkspaceContext(root: ProjectRootSnapshotInput): boolean {
  const rootPackageJson = root.packageJson;
  const normalizedFileContents = normalizeFileContents(root.fileContents);
  const rootFileSet = new Set(root.files.map((file) => file.name.toLowerCase()));

  return (
    hasPackageJsonWorkspaces(rootPackageJson) ||
    rootFileSet.has("pnpm-workspace.yaml") ||
    Boolean(normalizedFileContents["pnpm-workspace.yaml"])
  );
}

function buildRepoRootCommand(command: string, rootDirectory: string): string {
  if (!command) {
    return command;
  }

  const normalizedRoot = normalizeProjectRootDirectory(rootDirectory);
  if (!normalizedRoot) {
    return command;
  }

  const depth = normalizedRoot.split("/").length;
  const prefix = Array.from({ length: depth }, () => "..").join("/");
  return prefix ? `cd ${prefix} && ${command}` : command;
}

export function applyWorkspaceContext(
  rootInput: ProjectRootSnapshotInput,
  selectedProject: ProjectRootSnapshot,
): ProjectRootSnapshot {
  if (!selectedProject.rootDirectory || !hasRootWorkspaceContext(rootInput)) {
    return selectedProject;
  }

  const packageManager = detectPackageManager(
    rootInput.files,
    rootInput.packageJson as Record<string, unknown> & {
      packageManager?: string;
      scripts?: Record<string, string>;
      engines?: Record<string, string>;
    },
  );

  if (packageManager === "unknown") {
    return selectedProject;
  }

  const installCommand = getInstallCommand(packageManager);

  return {
    ...selectedProject,
    stack: {
      ...selectedProject.stack,
      packageManager,
      installCommand: installCommand
        ? buildRepoRootCommand(installCommand, selectedProject.rootDirectory)
        : selectedProject.stack.installCommand,
      buildCommand: getBuildCommand(packageManager, selectedProject.stack.stack, selectedProject.packageJson),
      startCommand: getStartCommand(packageManager, selectedProject.stack.stack, selectedProject.packageJson),
      buildImage: getBuildImage(selectedProject.stack.stack, packageManager),
    },
  };
}

function scoreCandidate(candidate: ProjectRootSnapshot): number {
  const { source, category, servicesProject, hasBuildScript, files, segments } = CANDIDATE_WEIGHTS;

  let score = source[candidate.source] ?? 0;
  score += category[candidate.stack.category as keyof typeof category] ?? 0;

  if (candidate.stack.projectType === "services") {
    score += servicesProject;
  }

  const scripts = candidate.packageJson?.scripts as Record<string, string> | undefined;
  if (scripts?.build) {
    score += hasBuildScript;
  }

  const candidateFileSet = new Set(candidate.files.map((file) => file.name.toLowerCase()));
  for (const [name, weight] of Object.entries(files)) {
    if (candidateFileSet.has(name)) score += weight;
  }

  const pathSegments = candidate.rootDirectory.split("/");
  const firstSegment = pathSegments[0]?.toLowerCase() ?? "";
  const lastSegment = pathSegments.at(-1)?.toLowerCase() ?? "";
  if (firstSegment === "apps") score += segments.firstIsApps;
  if (APPISH_ROOT_SEGMENTS.has(lastSegment)) score += segments.lastIsAppish;
  if (LIBRARY_ROOT_SEGMENTS.has(firstSegment)) score += segments.firstIsLibrary;
  if (pathSegments.length === 1) score += segments.shallowBonus;

  return score;
}

function selectPreferredCandidate(
  rootInput: ProjectRootSnapshotInput,
  candidateInputs: ProjectRootSnapshotInput[],
  options: {
    canSelect: (root: ProjectRootSnapshot) => boolean;
    isEligible: (candidate: ProjectRootSnapshot) => boolean;
    fallback: (root: ProjectRootSnapshot) => ProjectRootSnapshot | null;
  },
): ProjectRootSnapshot | null {
  const root = buildSnapshot(rootInput);
  if (!options.canSelect(root)) {
    return options.fallback(root);
  }

  let bestCandidate: ProjectRootSnapshot | null = null;
  let bestScore = -1;

  for (const candidateInput of candidateInputs) {
    const candidate = buildSnapshot(candidateInput);
    if (!options.isEligible(candidate)) {
      continue;
    }

    const candidateScore = scoreCandidate(candidate);
    if (candidateScore > bestScore) {
      bestCandidate = candidate;
      bestScore = candidateScore;
    }
  }

  return bestCandidate ?? options.fallback(root);
}

export function selectPreferredProjectRoot(
  rootInput: ProjectRootSnapshotInput,
  candidateInputs: ProjectRootSnapshotInput[],
): ProjectRootSnapshot {
  return selectPreferredCandidate(rootInput, candidateInputs, {
    canSelect: canPromoteNestedApp,
    isEligible: isNestedProjectCandidate,
    fallback: (root) => root,
  })!;
}

export function selectPreferredSingleAppRoot(
  rootInput: ProjectRootSnapshotInput,
  candidateInputs: ProjectRootSnapshotInput[],
): ProjectRootSnapshot | null {
  return selectPreferredCandidate(rootInput, candidateInputs, {
    canSelect: canExposeSingleAppAlternative,
    isEligible: isNestedSingleAppCandidate,
    fallback: () => null,
  });
}