import {
  STACK_ROOT_MARKERS,
  WORKSPACE_DETECTORS,
  WORKSPACE_MANIFEST_FILES,
  findMatchingDetectors,
  getBuildImage,
  parseVercelConfig,
  extractCdTargets,
  slugify,
  type WorkspaceDetector,
} from "@repo/core";
import {
  detectPackageManager,
  detectStack,
  getBuildCommand,
  getInstallCommand,
  getStartCommand,
  type RepoFile,
  type StackResult,
} from "./stack-detector";
import { posix as pathPosix } from "node:path";

/** JS package managers that benefit from the `cd ../.. && <pm> install` rewrite. */
const JS_PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

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

/**
 * Files that mark a directory as a project root candidate.
 *
 * Composed from:
 *   - {@link STACK_ROOT_MARKERS} - every stack's config files (next.config.*, vite.config.*,
 *     docker-compose.yml, requirements.txt, go.mod, Cargo.toml, etc.). Adding a stack with
 *     `detection.rootMarkers` in the core registry automatically flows here.
 *   - Workspace / monorepo project markers (Nx `project.json`) not tied to a single stack.
 */
const DISCOVERED_ROOT_MARKERS = new Set<string>([
  ...STACK_ROOT_MARKERS,
  // Nx workspace project marker - every Nx project has its own project.json.
  "project.json",
]);

const IGNORED_REPO_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".astro",
  ".turbo",
  ".vercel",
  ".venv",
  ".idea",
  ".vscode",
  ".cache",
  "__pycache__",
  "build",
  "dist",
  "out",
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

/**
 * Normalize one directory's raw listing into a snapshot + its detected stack.
 * Exported for callers that already KNOW the root (a user-declared compose path),
 * where the scoring in `selectPreferredProjectRoot` would only second-guess them.
 */
export function buildProjectRootSnapshot(input: ProjectRootSnapshotInput): ProjectRootSnapshot {
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
 * Walk every registered workspace detector and ask, "do you see your manifest
 * at this root, and if so, what sub-project paths does it declare?"
 *
 * Returns the flat list of detector matches (one detector can produce N patterns).
 * Multiple detectors can match the same repo (a polyglot monorepo with both
 * pnpm workspaces and a Cargo workspace); we return every match so the caller
 * can union the patterns and identify all workspace-sourced sub-projects.
 *
 * `package.json` is special-cased: we feed the already-parsed `rootPackageJson`
 * straight to its detector rather than the raw text, since the rest of the
 * pipeline has already parsed it.
 */
function detectWorkspaces(
  rootFileContents: Record<string, string> | undefined,
  rootPackageJson: Record<string, unknown> | undefined,
  rootFiles: ReadonlyArray<{ name: string }> = [],
): { detector: WorkspaceDetector; patterns: string[] }[] {
  const normalized = normalizeFileContents(rootFileContents);
  const matches: { detector: WorkspaceDetector; patterns: string[] }[] = [];
  const ranDetectors = new Set<string>();

  const recordMatch = (detector: WorkspaceDetector, patterns: string[]) => {
    if (ranDetectors.has(detector.id)) return;
    ranDetectors.add(detector.id);
    if (patterns.length > 0) matches.push({ detector, patterns });
  };

  // npm-workspaces gets a fast path: the caller has typically already parsed
  // package.json, so we feed it the object directly instead of re-parsing.
  if (rootPackageJson) {
    for (const detector of WORKSPACE_DETECTORS) {
      if (detector.id !== "npm-workspaces") continue;
      recordMatch(detector, extractPackageJsonWorkspacePatterns(rootPackageJson));
    }
  }

  // Static manifests with content (pnpm-workspace.yaml, Cargo.toml, go.work, pom.xml, …).
  for (const [filename, content] of Object.entries(normalized)) {
    if (!WORKSPACE_MANIFEST_FILES.has(filename)) continue;
    for (const detector of findMatchingDetectors(filename)) {
      recordMatch(detector, detector.parseSubProjects(content));
    }
  }

  // Regex-based manifests (e.g. *.sln). We scan the root file listing for the
  // filename pattern, then fall back to fileContents for the actual text.
  for (const file of rootFiles) {
    const filename = file.name;
    if (WORKSPACE_MANIFEST_FILES.has(filename.toLowerCase())) continue;
    const regexDetectors = WORKSPACE_DETECTORS.filter((detector) =>
      detector.manifestFiles.some((m) => m instanceof RegExp && m.test(filename)),
    );
    for (const detector of regexDetectors) {
      const content = normalized[filename.toLowerCase()];
      if (!content) continue;
      recordMatch(detector, detector.parseSubProjects(content));
    }
  }

  return matches;
}

/**
 * package.json workspaces extraction - the npm detector parses raw JSON, but
 * the rest of the project-root-detector already has the parsed object on hand.
 * Short-circuit straight to the value here to avoid a re-parse.
 */
function extractPackageJsonWorkspacePatterns(packageJson: Record<string, unknown>): string[] {
  const workspaces = packageJson.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
  }
  if (workspaces && typeof workspaces === "object") {
    const packages = (workspaces as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      return packages.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
    }
  }
  return [];
}

function getWorkspacePatterns(
  rootPackageJson?: Record<string, unknown>,
  rootFileContents?: Record<string, string>,
  rootFiles: ReadonlyArray<{ name: string }> = [],
): string[] {
  return detectWorkspaces(rootFileContents, rootPackageJson, rootFiles)
    .flatMap((match) => match.patterns)
    .map((pattern) => normalizeProjectRootDirectory(pattern))
    .filter(Boolean);
}

/** First detector whose package manager applies to JS workspace-context rewriting (if any). */
function detectJsWorkspaceManager(
  rootFileContents: Record<string, string> | undefined,
  rootPackageJson: Record<string, unknown> | undefined,
  rootFiles: ReadonlyArray<{ name: string }> = [],
): string | null {
  for (const match of detectWorkspaces(rootFileContents, rootPackageJson, rootFiles)) {
    const pm = match.detector.packageManager;
    if (pm && JS_PACKAGE_MANAGERS.has(pm)) return pm;
  }
  return null;
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

/**
 * True if a normalized candidate path escapes the repo (e.g. "..", "../sibling")
 * or hits an ignored directory. Used to filter junk hints from `vercel.json`
 * that point outside the deployable tree.
 */
function isOutsideRepoCandidate(candidate: string): boolean {
  if (!candidate) return true;
  return candidate.split("/").some((segment) => segment === "..");
}

export function parseVercelRootDirectories(vercelConfig?: string): string[] {
  if (!vercelConfig) {
    return [];
  }

  // Reuse the single vercel.json parser + `cd`-target extractor from @repo/core
  // (same source the stack detector reads) so we never parse the file twice or
  // drift on how a build command's directory is detected.
  const parsed = parseVercelConfig(vercelConfig);
  if (!parsed) {
    return [];
  }

  const directories = new Set<string>();
  const addCandidate = (value: string) => {
    const candidate = normalizeProjectRootDirectory(value);
    if (candidate && !isOutsideRepoCandidate(candidate) && !isIgnoredRepoPath(candidate)) {
      directories.add(candidate);
    }
  };

  for (const target of extractCdTargets(parsed.buildCommand)) {
    addCandidate(target);
  }

  if (parsed.outputDirectory) {
    const outputDir = pathPosix.dirname(parsed.outputDirectory);
    // dirname("dist") === "." - that's the repo root, not a useful hint.
    if (outputDir && outputDir !== ".") {
      addCandidate(outputDir);
    }
  }

  return [...directories];
}

export function discoverProjectRootHints(
  treeEntries: RepoTreeEntry[],
  rootFileContents?: Record<string, string>,
  rootPackageJson?: Record<string, unknown>,
): ProjectRootHint[] {
  const hints = new Map<string, ProjectRootHint>();
  // Synthesize the depth-0 file listing from the tree so workspace
  // detectors that match by regex (e.g. *.sln) can find their manifest
  // - without this, getWorkspacePatterns defaults rootFiles to [] and
  // the regex path in detectWorkspaces is skipped entirely.
  const rootFiles = treeEntries
    .filter((entry) => {
      const t = entry.type?.toLowerCase();
      if (t && t !== "file" && t !== "blob") return false;
      return entry.path.length > 0 && !entry.path.includes("/");
    })
    .map((entry) => ({ name: entry.path }));
  const workspacePatterns = getWorkspacePatterns(rootPackageJson, rootFileContents, rootFiles);
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

  // Seed hints directly from concrete (non-glob) workspace patterns.
  // Detectors like .sln emit precise project paths ("src/Api",
  // "src/Web") - those ARE the project roots; we don't need a tree
  // marker to confirm them. Essential for .NET, where .csproj file
  // basenames vary per repo and can never appear in
  // DISCOVERED_ROOT_MARKERS. Glob-based patterns (e.g. pnpm
  // "apps/*") are skipped - the tree-marker loop above already
  // handles those.
  for (const pattern of workspacePatterns) {
    if (/[*?[\]]/.test(pattern)) continue;
    const rootDirectory = normalizeProjectRootDirectory(pattern);
    if (!rootDirectory || isIgnoredRepoPath(rootDirectory)) continue;
    const existing = hints.get(rootDirectory);
    if (!existing || sourcePriority("workspace") > sourcePriority(existing.source)) {
      hints.set(rootDirectory, { rootDirectory, source: "workspace" });
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

/**
 * True when the repo root declares a JS workspace (pnpm/npm/yarn/Rush) - the
 * subset of workspace families where install commands need rewriting to the
 * repo root via `cd ../.. && pnpm install`. Cargo / Go / .NET workspaces don't
 * qualify because their build tools resolve workspace context implicitly.
 */
function hasJsWorkspaceContext(root: ProjectRootSnapshotInput): boolean {
  return (
    detectJsWorkspaceManager(root.fileContents, root.packageJson, root.files) !== null
  );
}

/**
 * True when the repo root has ANY recognized workspace manifest (JS or otherwise) -
 * used by monorepo discovery to decide whether a multi-sub-app flow applies.
 */
function hasAnyWorkspaceContext(root: ProjectRootSnapshotInput): boolean {
  return (
    detectWorkspaces(root.fileContents, root.packageJson, root.files).length > 0
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
  if (!selectedProject.rootDirectory || !hasJsWorkspaceContext(rootInput)) {
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
  const root = buildProjectRootSnapshot(rootInput);
  if (!options.canSelect(root)) {
    return options.fallback(root);
  }

  let bestCandidate: ProjectRootSnapshot | null = null;
  let bestScore = -1;

  for (const candidateInput of candidateInputs) {
    const candidate = buildProjectRootSnapshot(candidateInput);
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

// ─── Monorepo detection ──────────────────────────────────────────────────────

export interface MonorepoWorkspace {
  /** Package manager declared at the repo root (npm/pnpm/yarn/bun). */
  packageManager: string;
  /**
   * Initial suggested prepare command — runs ONCE at the repo root
   * before per-sub-app builds. Detector seeds this with the workspace-
   * aware install (e.g. "pnpm install" / "npm install"); operators can
   * edit it to chain additional prep (codegen, schema sync) with `&&`.
   */
  prepareCommand: string;
}

export interface MonorepoApp {
  /** Stable identifier for this sub-app (e.g. "apps/web"). */
  id: string;
  /** Display name AND infra identifier (container/network name) - last segment
   *  of rootDirectory, or a Docker-safe slug of package.json name. Always
   *  matches `[a-zA-Z0-9][a-zA-Z0-9_.-]*`; see `sanitizeAppName`. */
  name: string;
  rootDirectory: string;
  stack: StackResult["stack"];
  category: string;
  packageManager: string;
  buildCommand: string;
  installCommand: string;
  startCommand: string;
  buildImage: string;
  outputDirectory: string;
  productionPaths: string[];
  port: number;
}

/** Categories that make the repo ROOT itself an independently deployable app. */
const ROOT_APP_CATEGORIES = new Set(["backend", "frontend", "fullstack", "static", "generic"]);

/** JS lockfiles that mark a nested dir as self-contained (its own dep tree). */
const NESTED_LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
]);

/**
 * Non-JS manifests that, on their own, make a nested dir a self-contained
 * deployable project (independent of the root's package manager / workspace).
 */
const NESTED_STANDALONE_MANIFESTS = new Set([
  "go.mod",
  "cargo.toml",
  "requirements.txt",
  "pyproject.toml",
  "pipfile",
  "gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "mix.exs",
]);

/**
 * The repo root is a deployable app in its own right (not just a workspace
 * container): a recognized app stack with a build or start command. Repos with
 * a root like this + an independent nested app are implicit monorepos even
 * without a workspace manifest (e.g. a root Express API + a `frontend/` SPA).
 */
const DOTNET_PROJECT_FILE = /\.(cs|fs)proj$/i;

/**
 * A .NET project is only deployable when it's a web app, worker service, or
 * executable — detected via the standard project markers (not repo-specific
 * names): the Web/Worker/Blazor SDK, `<OutputType>Exe</OutputType>`, or an
 * ASP.NET Core reference. A plain `Microsoft.NET.Sdk` class library builds a
 * .dll that a deployable project references; it is never a standalone app.
 */
function isDeployableDotnetProject(content: string): boolean {
  return (
    /\bSdk\s*=\s*["']Microsoft\.NET\.Sdk\.(Web|Worker|BlazorWebAssembly)["']/i.test(content) ||
    /<OutputType>\s*Exe\s*<\/OutputType>/i.test(content) ||
    /Microsoft\.AspNetCore/i.test(content)
  );
}

/**
 * True when a directory's .NET project files are ALL class libraries — nothing
 * independently deployable. Without this, every `.csproj` in a multi-project
 * solution (e.g. Web + DataAccess + BusinessLogic) becomes its own "app" and
 * gets its own domain. Conservative on missing data: returns false when there
 * are no project files or their bodies weren't loaded, so a real app is never
 * hidden.
 */
function isDotnetLibraryOnly(snapshot: ProjectRootSnapshot): boolean {
  if (!snapshot.files.some((file) => DOTNET_PROJECT_FILE.test(file.name))) return false;
  const bodies = Object.entries(snapshot.fileContents)
    .filter(([name]) => DOTNET_PROJECT_FILE.test(name))
    .map(([, content]) => content)
    .filter((content): content is string => typeof content === "string" && content.length > 0);
  if (bodies.length === 0) return false;
  return !bodies.some(isDeployableDotnetProject);
}

function isDeployableRootApp(root: ProjectRootSnapshot): boolean {
  if (root.stack.stack === "unknown") return false;
  if (root.stack.projectType !== "app") return false;
  if (isDotnetLibraryOnly(root)) return false;
  if (!ROOT_APP_CATEGORIES.has(root.stack.category)) return false;
  return isSetCmd(root.stack.buildCommand) || isSetCmd(root.stack.startCommand);
}

function isSetCmd(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Stricter than `isMonorepoAppCandidate`: for the manifest-less (implicit)
 * monorepo path, a nested candidate counts only when it is self-contained -
 * its own JS lockfile, a `vercel.json`-sourced hint, or a non-JS manifest. This
 * keeps ordinary single apps (e.g. one with an `examples/` folder that merely
 * has a bare package.json) from being mistaken for monorepos.
 */
function isIndependentlyDeployable(candidate: ProjectRootSnapshot): boolean {
  if (candidate.source === "vercel") return true;
  const fileNames = new Set(candidate.files.map((file) => file.name.toLowerCase()));
  for (const lock of NESTED_LOCKFILES) if (fileNames.has(lock)) return true;
  for (const manifest of NESTED_STANDALONE_MANIFESTS) if (fileNames.has(manifest)) return true;
  // .NET project/solution files have per-repo names - match by suffix. But a
  // class-library project isn't independently deployable (it's a .dll a web
  // project links), so a library-only directory doesn't count as an app.
  if (isDotnetLibraryOnly(candidate)) return false;
  for (const name of fileNames) {
    if (name.endsWith(".csproj") || name.endsWith(".fsproj") || name.endsWith(".sln")) return true;
  }
  return false;
}

/**
 * `MonorepoApp.name` isn't just a display label - it's persisted as
 * `Service.name` and consumed verbatim as a Docker container/network name
 * (see compose/build.service.ts, runtime/docker.ts's `createServiceContainer`),
 * which only allows `[a-zA-Z0-9][a-zA-Z0-9_.-]*`. A `package.json` name is
 * frequently npm-scoped ("@virtalio/saas" - the norm for pnpm/turborepo
 * workspaces), and "@"/"/" both fail that pattern, so a raw scoped name
 * deploys fine right up until container creation, which fails with a cryptic
 * "Invalid container name" from the Docker daemon. Fold the scope into the
 * name (rather than dropping it) so sibling apps under different scopes,
 * or the same package name under different scopes, don't collide.
 */
function sanitizeAppName(raw: string): string {
  return slugify(raw.replace(/^@/, "").replace(/\//g, "-"));
}

function toMonorepoApp(snapshot: ProjectRootSnapshot, overrides?: { id?: string; rootDirectory?: string }): MonorepoApp {
  const rootDirectory = overrides?.rootDirectory ?? snapshot.rootDirectory;
  const segments = snapshot.rootDirectory.split("/");
  const stack = snapshot.stack;
  const packageName = (snapshot.packageJson?.name as string | undefined)?.trim();
  const name =
    (packageName && sanitizeAppName(packageName)) ||
    segments.at(-1) ||
    rootDirectory ||
    "app";

  // A sub-app the Dockerfile owns carries no buildpack commands: the pipeline
  // takes the Dockerfile branch on `stack === "docker"` (see cloud.ts /
  // docker.ts) and ignores them, so a detected `npm i --force` — which
  // detectStack still emits from a sibling package.json — is a lie in the UI and
  // in the persisted service. Keyed on the STACK, not on "a Dockerfile exists":
  // a Next.js app that merely ships an optional Dockerfile detects as `nextjs`
  // and still builds via buildpack, so blanking its commands would leave it with
  // nothing to install, build, or start.
  const dockerOwnsBuild = stack.stack === "docker";
  // Static sub-apps keep an empty start command: the monorepo build pipeline
  // serves them as files — via the edge on self-hosted, a generated nginx image on
  // cloud (see isStaticService /
  // the static Dockerfile branch). Server sub-apps carry their real start command.
  return {
    id: overrides?.id ?? snapshot.rootDirectory,
    name,
    rootDirectory,
    stack: stack.stack,
    category: stack.category,
    // Same "unknown" → "npm" normalization as prepare.service.ts's ProjectInfo
    // builder (issue #415) — this MonorepoApp round-trips through the dashboard
    // into project creation just like the single-root path does, and
    // PackageManagerEnum rejects the raw sentinel the same way there.
    packageManager: stack.packageManager === "unknown" ? "npm" : stack.packageManager,
    buildCommand: dockerOwnsBuild ? "" : stack.buildCommand,
    installCommand: dockerOwnsBuild ? "" : stack.installCommand,
    startCommand: dockerOwnsBuild ? "" : stack.startCommand,
    buildImage: stack.buildImage,
    outputDirectory: stack.outputDirectory,
    productionPaths: stack.productionPaths,
    port: stack.port,
  };
}

/**
 * A repo is treated as a monorepo when EITHER:
 *   - its root declares a workspace manifest AND we discover ≥2 deployable
 *     sub-app candidates (the root is the workspace container, not an app), OR
 *   - (implicit / manifest-less) the root is itself a deployable app AND we
 *     discover ≥1 independently-deployable nested app - e.g. a root Express API
 *     plus a `frontend/` SPA, each with its own vercel.json. The root is emitted
 *     as the first app with `rootDirectory: "."` (the only value that survives
 *     the schema/service/preflight/change-routing layers as "the repo root").
 *
 * Returns null when the repo doesn't qualify (single-app, services, plain backend, etc.).
 */
export function discoverMonorepoApps(
  rootInput: ProjectRootSnapshotInput,
  candidateInputs: ProjectRootSnapshotInput[],
): { apps: MonorepoApp[]; workspace: MonorepoWorkspace } | null {
  const candidates = candidateInputs
    .map(buildProjectRootSnapshot)
    .filter(isMonorepoAppCandidate);

  const workspacePackageManager = detectPackageManager(
    rootInput.files,
    rootInput.packageJson as Record<string, unknown> & {
      packageManager?: string;
      scripts?: Record<string, string>;
      engines?: Record<string, string>;
    },
  );
  const resolvedPackageManager = workspacePackageManager === "unknown" ? "npm" : workspacePackageManager;

  let apps: MonorepoApp[];
  let prepareCommand: string;

  if (hasAnyWorkspaceContext(rootInput)) {
    // Formal workspace monorepo: nested apps only; root is the container. A
    // shared install runs once at the repo root before each app builds.
    if (candidates.length < 2) return null;
    apps = candidates.map((candidate) => toMonorepoApp(candidate));
    prepareCommand = getInstallCommand(resolvedPackageManager) || "";
  } else {
    // Implicit monorepo: deployable root app + ≥1 self-contained nested app.
    const rootSnapshot = buildProjectRootSnapshot(rootInput);
    const independent = candidates.filter(isIndependentlyDeployable);
    if (!isDeployableRootApp(rootSnapshot) || independent.length < 1) return null;
    apps = [
      toMonorepoApp(rootSnapshot, { id: ".", rootDirectory: "." }),
      ...independent.map((candidate) => toMonorepoApp(candidate)),
    ];
    // No workspace install to run - each app installs itself from its own root.
    prepareCommand = "";
  }

  if (apps.length < 2) return null;

  return {
    apps,
    workspace: {
      packageManager: resolvedPackageManager,
      prepareCommand,
    },
  };
}

/**
 * Stricter than `isNestedProjectCandidate`: monorepo sub-apps must be actual
 * deployable apps (no `services` projects - those belong to the compose flow,
 * not the monorepo flow). Library directories under `packages/` are still
 * filtered out by `scoreCandidate`'s segment penalty; we additionally reject
 * `unknown` stacks so we don't list every directory containing a manifest.
 *
 * `projectType === "docker"` (a directory with its own Dockerfile) is
 * ALSO accepted, not just "app": a Railway/per-service-Dockerfile-style
 * monorepo (e.g. `apps/api/Dockerfile`, `apps/web/Dockerfile`) is exactly as
 * deployable as a buildpack-detected app - the build pipeline already builds
 * a "docker"-stack sub-app straight from its own Dockerfile at its
 * `rootDirectory`, same as a standalone docker-stack project (see
 * compose/build.service.ts's monorepo build path). Excluding these dropped
 * every sub-app to 0 candidates for any monorepo built this way, so
 * `discoverMonorepoApps` silently returned null instead of detecting it.
 */
function isMonorepoAppCandidate(candidate: ProjectRootSnapshot): boolean {
  if (!candidate.rootDirectory) return false;
  if (candidate.stack.stack === "unknown") return false;
  if (candidate.stack.projectType !== "app" && candidate.stack.projectType !== "docker")
    return false;
  // A .NET class library is not a deployable app — only web/service/exe projects are.
  if (isDotnetLibraryOnly(candidate)) return false;
  // Library segments first (packages/, libs/, shared/, …) are not deployable on their own.
  const firstSegment = candidate.rootDirectory.split("/")[0]?.toLowerCase();
  if (firstSegment && LIBRARY_ROOT_SEGMENTS.has(firstSegment)) return false;
  return true;
}