/**
 * Prepare service - resolves project info from a source (GitHub or local path).
 *
 * Pure introspection: reads files, detects stack, returns a unified shape.
 * No database writes, no deployment logic.
 */

import * as githubService from "../github/github.service";
import type { RequestContext } from "../../lib/request-context";
import { MANIFEST_FILES, type RepoFile, type StackResult } from "../../lib/stack-detector";
import { parseComposeEnvFile, parseComposeFile, type ComposeService } from "../../lib/compose-parser";
import {
  applyWorkspaceContext,
  discoverMonorepoApps,
  discoverProjectRootHints,
  normalizeProjectRootDirectory,
  selectPreferredProjectRoot,
  type MonorepoApp,
  type MonorepoWorkspace,
  type ProjectRootSnapshot,
  type ProjectRootSnapshotInput,
  type RepoTreeEntry,
} from "../../lib/project-root-detector";
import {
  parseDeploymentMetadata,
  parseOpenshipConfigJson,
  METADATA_FILES,
  type ProjectType,
  type RoutingConfig,
  type OpenshipConfig,
  type OpenshipDomain,
  type OpenshipEnv,
  type OpenshipService,
  type OpenshipResources,
  type OpenshipMonorepoApp,
} from "@repo/core";
import { env } from "../../config";
import { createGitHubReader, createGitLabReader, type ProjectReader } from "./project-reader";

const PREPARE_FILE_CONTENTS = [
  ...MANIFEST_FILES,
  // Platform-config files (vercel.json / render.yaml / railway.{toml,json}) come
  // from the metadata parser registry, so adding a parser reads its file here too.
  ...METADATA_FILES,
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "rush.json",
] as const;
const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"] as const;


export type Source =
  | {
      source: "github";
      owner: string;
      repo: string;
      branch?: string;
      /** Request-scoped context — required when source === "github" so
       *  getRepository can resolve org-scoped install + cache keys.
       *  Optional in the type for back-compat with old callers; the
       *  github resolver throws when it's missing. */
      ctx?: RequestContext;
    }
  | {
      source: "gitlab";
      owner: string;
      repo: string;
      /** Numeric GitLab project id. */
      projectId: number;
      branch?: string;
      ctx?: RequestContext;
    }
  | { source: "local"; path: string };

export interface ProjectInfo {
  repository: {
    name: string;
    full_name: string;
    owner: { login: string };
    private: boolean;
    default_branch: string;
    selected_branch?: string;
    clone_url?: string;
    html_url?: string;
    branches?: { name: string }[];
  };
  stack: StackResult["stack"];
  projectType: ProjectType;
  category: string;
  packageManager: string;
  buildCommand: string;
  installCommand: string;
  startCommand: string;
  buildImage: string;
  outputDirectory: string;
  rootDirectory: string;
  productionPaths: string[];
  port: number;
  services?: ComposeService[];
  monorepoApps?: MonorepoApp[];
  monorepoWorkspace?: MonorepoWorkspace;
  rootEnv?: Record<string, string>;
  /** Routing config parsed from the repo-root `vercel.json`/`openship.json`
   *  (rewrites/redirects/headers/cleanUrls/trailingSlash). Persisted on the
   *  project + compiled to OpenResty at deploy. */
  routing?: RoutingConfig;
  // ── Declared overlay (repo-root `openship.json`) ─────────────────────────
  // Fields the heuristic detector doesn't produce, declared by the user and
  // authoritative when present. Build-shaping fields (framework/commands/
  // output/routing) fold in through the metadata parser and appear above.
  /** How the app is served: "host"/"static"/"standalone" (seeds hasServer). */
  productionMode?: "host" | "static" | "standalone";
  /** Bare-metal vs Docker runtime, declared intent (git apps pick at deploy). */
  runtimeMode?: "bare" | "docker";
  /** Declared public endpoints (from `domains`), normalized to the create shape. */
  publicEndpoints?: DeclaredPublicEndpoint[];
  /** Declared resource sizing (cloud tier or explicit cpu/mem/disk). */
  resources?: OpenshipResources;
}

/** A `domains[]` entry normalized to the `CreateProjectBody.publicEndpoints` shape. */
export interface DeclaredPublicEndpoint {
  domain?: string;
  customDomain?: string;
  domainType: "free" | "custom";
  port?: number;
  targetPath?: string;
}

/**
 * Routing config is a repo-ROOT concern (the root `vercel.json`), so read it
 * from the root snapshot's file contents regardless of which sub-app is selected
 * as the primary. Returns the first source that declares routing (vercel today).
 */
function extractRootRouting(fileContents: Record<string, string>): RoutingConfig | undefined {
  const lower: Record<string, string> = {};
  for (const [name, content] of Object.entries(fileContents)) lower[name.toLowerCase()] = content;
  for (const meta of parseDeploymentMetadata(lower)) {
    if (meta.routing) return meta.routing;
  }
  return undefined;
}

/**
 * Parse the repo-ROOT `openship.json` (case-insensitive) into a validated config.
 * The prepare pipeline overlays it leniently: validation `errors` are ignored
 * here (surfaced by `openship config validate`); only well-formed fields overlay.
 * Its build-shaping subset flows separately through the metadata parser fold.
 */
function extractOpenshipConfig(fileContents: Record<string, string>): OpenshipConfig | undefined {
  const entry = Object.entries(fileContents).find(([name]) => name.toLowerCase() === "openship.json");
  if (!entry?.[1]) return undefined;
  return parseOpenshipConfigJson(entry[1]).config ?? undefined;
}

/**
 * Normalize declared `domains[]` to the `CreateProjectBody.publicEndpoints`
 * shape. A hostname with a dot is a custom domain (goes in `customDomain`); a
 * bare label is a free subdomain (goes in `domain`). Honors an explicit `type`.
 */
function domainsToPublicEndpoints(domains: OpenshipDomain[]): DeclaredPublicEndpoint[] {
  return domains.map((d) => {
    const isCustom = d.type ? d.type === "custom" : d.domain.includes(".");
    return {
      ...(isCustom ? { customDomain: d.domain } : { domain: d.domain }),
      domainType: isCustom ? ("custom" as const) : ("free" as const),
      ...(d.port !== undefined && { port: d.port }),
      ...(d.targetPath !== undefined && { targetPath: d.targetPath }),
    };
  });
}

/**
 * Flatten declared env to the plain `Record<string,string>` used both by compose
 * rows and the project-level `rootEnv` seed. The `secret` flag is dropped here —
 * the deploy seeds these as editable env rows (the user marks secrets in the UI /
 * the env-merge endpoint is the encrypt-at-rest path); a declared value is never
 * an opaque masked secret at this stage.
 */
function envMapToRecord(envMap: OpenshipEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(envMap)) out[k] = typeof v === "string" ? v : v.value;
  return out;
}

/** Split a declared hostname into the (customDomain|domain, domainType) pair. */
function splitDomain(host: string): { domain?: string; customDomain?: string; domainType: "free" | "custom" } {
  return host.includes(".")
    ? { customDomain: host, domainType: "custom" }
    : { domain: host, domainType: "free" };
}

/**
 * Map declared `services[]` to the compose-service rows the deploy pipeline
 * persists. A declared service is a full compose definition, so this replaces
 * detection (the project becomes a `services` project). Healthcheck maps into
 * the `advanced` JSONB blob, mirroring the compose parser.
 */
function openshipServicesToCompose(services: OpenshipService[]): ComposeService[] {
  return services.map((s) => {
    const domain = s.domain ? splitDomain(s.domain) : undefined;
    return {
      name: s.name,
      ...(s.image && { image: s.image }),
      ...(s.build && { build: s.build }),
      ...(s.dockerfile && { dockerfile: s.dockerfile }),
      ports: s.ports ?? [],
      dependsOn: s.dependsOn ?? [],
      environment: s.env ? envMapToRecord(s.env) : {},
      volumes: s.volumes ?? [],
      ...(s.command && { command: s.command }),
      ...(s.restart && { restart: s.restart }),
      ...(s.healthcheck && { advanced: { healthcheck: s.healthcheck } }),
      ...(s.exposed !== undefined && { exposed: s.exposed }),
      ...(s.exposedPort && { exposedPort: s.exposedPort }),
      ...(domain ?? {}),
    };
  });
}

/**
 * Merge declared monorepo app OVERRIDES onto the detector's discovered sub-apps,
 * matched by normalized `rootDirectory`. Only fields the user set override the
 * detected value; unmatched declarations are ignored (declaring apps the
 * detector didn't find is out of scope — use per-sub-app config instead).
 */
function mergeMonorepoApps(detected: MonorepoApp[], declared: OpenshipMonorepoApp[]): MonorepoApp[] {
  const byRoot = new Map(
    declared.map((d) => [normalizeProjectRootDirectory(d.rootDirectory), d]),
  );
  return detected.map((app) => {
    const d = byRoot.get(normalizeProjectRootDirectory(app.rootDirectory));
    if (!d) return app;
    return {
      ...app,
      ...(d.framework && { stack: d.framework }),
      ...(d.packageManager && { packageManager: d.packageManager }),
      ...(d.installCommand && { installCommand: d.installCommand }),
      ...(d.buildCommand && { buildCommand: d.buildCommand }),
      ...(d.startCommand && { startCommand: d.startCommand }),
      ...(d.outputDirectory && { outputDirectory: d.outputDirectory }),
      ...(d.buildImage && { buildImage: d.buildImage }),
      ...(d.port !== undefined && { port: d.port }),
    };
  });
}

/**
 * Overlay a repo-root `openship.json` onto detected ProjectInfo. Only the fields
 * the metadata parser can't carry (runtime/port/productionMode/sleepMode/domains/
 * env) are applied here; each present field wins over detection, absent fields
 * keep the detected value. Mutates + returns `info` for call-site brevity.
 */
function applyOpenshipOverlay(info: ProjectInfo, config: OpenshipConfig | undefined): ProjectInfo {
  if (!config) return info;
  if (config.packageManager) info.packageManager = config.packageManager;
  if (config.rootDirectory) info.rootDirectory = config.rootDirectory;
  if (config.buildImage) info.buildImage = config.buildImage;
  if (config.productionPaths) info.productionPaths = config.productionPaths;
  if (config.port !== undefined) info.port = config.port;
  if (config.productionMode) info.productionMode = config.productionMode;
  if (config.runtime) info.runtimeMode = config.runtime;
  if (config.domains?.length) info.publicEndpoints = domainsToPublicEndpoints(config.domains);
  if (config.env && Object.keys(config.env).length > 0) {
    // Merge onto detected `.env` seed (declared wins per key) so declared env
    // flows through the existing rootEnv → wizard env-row seam.
    info.rootEnv = { ...(info.rootEnv ?? {}), ...envMapToRecord(config.env) };
  }
  if (config.resources) info.resources = config.resources;

  // Declared compose services replace detection: the project IS a services
  // project. runtimeMode="docker" then falls out of buildProductionProjectInput's
  // projectType pin, so no explicit runtime is needed here.
  if (config.services?.length) {
    info.services = openshipServicesToCompose(config.services);
    info.projectType = "services";
  }

  // Monorepo: overlay workspace + merge per-app build overrides onto the
  // detector's discovered sub-apps. Only meaningful once detection produced
  // sub-apps (declaring apps from scratch is out of scope — see mergeMonorepoApps).
  if (config.monorepo) {
    if (config.monorepo.workspace && info.monorepoWorkspace) {
      info.monorepoWorkspace = {
        packageManager: config.monorepo.workspace.packageManager,
        prepareCommand:
          config.monorepo.workspace.prepareCommand ?? info.monorepoWorkspace.prepareCommand,
      };
    }
    if (config.monorepo.apps?.length && info.monorepoApps?.length) {
      info.monorepoApps = mergeMonorepoApps(info.monorepoApps, config.monorepo.apps);
    }
  }
  return info;
}

/**
 * Shared ProjectInfo → scan-response mapping. Used by BOTH the local-folder
 * scan (project.controller.scanLocal) and the folder-upload scan
 * (folder.controller.scanSession) so their payload shape can't drift. Callers
 * add their own extra field (`path` / `sessionId`) alongside.
 */
export function projectInfoToScanResponse(result: ProjectInfo) {
  return {
    name: result.repository.name,
    stack: result.stack,
    projectType: result.projectType,
    category: result.category,
    packageManager: result.packageManager,
    installCommand: result.installCommand,
    buildCommand: result.buildCommand,
    startCommand: result.startCommand,
    buildImage: result.buildImage,
    outputDirectory: result.outputDirectory,
    rootDirectory: result.rootDirectory,
    productionPaths: result.productionPaths,
    port: result.port,
    services: result.services,
    // Declared-overlay fields (openship.json) — omitted from the response when
    // absent so a repo without the file yields the exact same payload as before.
    ...(result.productionMode && { productionMode: result.productionMode }),
    ...(result.runtimeMode && { runtimeMode: result.runtimeMode }),
    ...(result.publicEndpoints && { publicEndpoints: result.publicEndpoints }),
    ...(result.resources && { resources: result.resources }),
    ...(result.rootEnv && Object.keys(result.rootEnv).length > 0 && { rootEnv: result.rootEnv }),
    ...(result.routing && { routing: result.routing }),
    ...(result.monorepoWorkspace && { monorepoWorkspace: result.monorepoWorkspace }),
    ...(result.monorepoApps && { monorepoApps: result.monorepoApps }),
  };
}

function joinProjectPath(rootDirectory: string, name: string): string {
  const normalizedRootDirectory = normalizeProjectRootDirectory(rootDirectory);
  return normalizedRootDirectory ? `${normalizedRootDirectory}/${name}` : name;
}

async function readProjectSnapshot(
  reader: ProjectReader,
  rootDirectory = "",
  source: ProjectRootSnapshotInput["source"] = "root",
): Promise<ProjectRootSnapshotInput> {
  const normalizedRootDirectory = normalizeProjectRootDirectory(rootDirectory);
  const files = await reader.listDirectory(normalizedRootDirectory);
  const packageJson = await reader.readJson(joinProjectPath(normalizedRootDirectory, "package.json"));
  const fileContents: Record<string, string> = {};

  await Promise.all(
    PREPARE_FILE_CONTENTS
      .filter((name) => files.some((file) => file.name.toLowerCase() === name.toLowerCase()))
      .map(async (name) => {
        const content = await reader.readText(joinProjectPath(normalizedRootDirectory, name));
        if (content) {
          fileContents[name] = content;
        }
      }),
  );

  // Workspace/project manifests with dynamic basenames - PREPARE_FILE_CONTENTS
  // is a static list, but .NET solution/project files are named per-repo (e.g.
  // `MedicaScopeLMS.sln`, `Api.csproj`) so the lowercase-equality match above
  // would miss them. Without the .sln body, `detectWorkspaces` can't discover
  // sub-projects; without each .csproj/.fsproj body, we can't tell a deployable
  // web/service project from a class library (see isDotnetLibraryOnly), so every
  // project in a solution wrongly becomes its own deployable app.
  await Promise.all(
    files
      .filter((file) => /\.(sln|csproj|fsproj)$/i.test(file.name))
      .map(async (file) => {
        const content = await reader.readText(joinProjectPath(normalizedRootDirectory, file.name));
        if (content) {
          fileContents[file.name] = content;
        }
      }),
  );

  return {
    rootDirectory: normalizedRootDirectory,
    files,
    packageJson,
    fileContents,
    source,
  };
}

async function loadCandidateSnapshot(
  reader: ProjectReader,
  rootDirectory: string,
  source: ProjectRootSnapshotInput["source"],
): Promise<ProjectRootSnapshotInput | null> {
  const snapshot = await readProjectSnapshot(reader, rootDirectory, source);
  if (!snapshot.rootDirectory || snapshot.files.length === 0) {
    return null;
  }

  return snapshot;
}

interface SelectedProjectSnapshot {
  selected: ProjectRootSnapshot;
  monorepo: { apps: MonorepoApp[]; workspace: MonorepoWorkspace } | null;
}

async function selectProjectSnapshot(
  reader: ProjectReader,
  rootSnapshot: ProjectRootSnapshotInput,
): Promise<SelectedProjectSnapshot> {
  const treeEntries = await reader.listTree().catch(() => [] as RepoTreeEntry[]);
  const hints = discoverProjectRootHints(
    treeEntries,
    rootSnapshot.fileContents,
    rootSnapshot.packageJson,
  );

  const candidates = (await Promise.all(
    hints.map((hint) => loadCandidateSnapshot(reader, hint.rootDirectory, hint.source)),
  )).filter((candidate): candidate is ProjectRootSnapshotInput => Boolean(candidate));

  const selected = applyWorkspaceContext(
    rootSnapshot,
    selectPreferredProjectRoot(rootSnapshot, candidates),
  );
  const monorepo = discoverMonorepoApps(rootSnapshot, candidates);

  return { selected, monorepo };
}


async function readProjectText(
  reader: ProjectReader,
  rootDirectory: string,
  name: string,
): Promise<string | undefined> {
  return reader.readText(joinProjectPath(rootDirectory, name));
}

async function readComposeText(
  reader: ProjectReader,
  rootDirectory: string,
  files: RepoFile[],
): Promise<string | undefined> {
  for (const name of COMPOSE_FILES) {
    if (!files.some((file) => file.name.toLowerCase() === name)) {
      continue;
    }

    const composeContent = await readProjectText(reader, rootDirectory, name);
    if (composeContent) {
      return composeContent;
    }
  }

  return undefined;
}

/**
 * Resolve project info from either a GitHub repo or a local filesystem path.
 * Both paths converge on detectStack and return the same ProjectInfo shape.
 */
export async function resolveProjectInfo(input: Source): Promise<ProjectInfo> {
  if (input.source === "github") {
    if (!input.ctx) {
      throw new Error("resolveProjectInfo(github): ctx is required");
    }
    return resolveFromGitHub(input.ctx, input.owner, input.repo, input.branch);
  }

  if (input.source === "gitlab") {
    if (!input.ctx) {
      throw new Error("resolveProjectInfo(gitlab): ctx is required");
    }
    return resolveFromGitLab(
      input.ctx,
      input.projectId,
      input.owner,
      input.repo,
      input.branch,
    );
  }

  if (env.CLOUD_MODE) {
    throw new Error("Local project resolution is not available in cloud mode");
  }

  // Dynamic import keeps local-source (node:fs) out of the cloud module graph.
  const { resolveFromLocal } = await import("./local-source");
  return resolveFromLocal(input.path);
}

type RepoMeta = Parameters<typeof toProjectInfo>[0];

/**
 * Shared resolution pipeline: snapshot → select root → read compose/.env → map.
 * Source-specific work (auth, branch validation, fs stat) lives in the callers.
 */
export async function resolveFromReader(
  reader: ProjectReader,
  repoMeta: RepoMeta,
  selectedBranch: string,
): Promise<ProjectInfo> {
  const rootSnapshot = await readProjectSnapshot(reader);
  const { selected, monorepo } = await selectProjectSnapshot(reader, rootSnapshot);
  const [composeContent, composeEnvContent] = await Promise.all([
    readComposeText(reader, selected.rootDirectory, selected.files),
    readProjectText(reader, selected.rootDirectory, ".env"),
  ]);
  const routing = extractRootRouting(rootSnapshot.fileContents ?? {});
  const openshipConfig = extractOpenshipConfig(rootSnapshot.fileContents ?? {});

  const info = toProjectInfo(repoMeta, selected, composeContent, selectedBranch, composeEnvContent, monorepo, routing);
  return applyOpenshipOverlay(info, openshipConfig);
}

async function resolveFromGitHub(
  ctx: RequestContext,
  owner: string,
  repo: string,
  branch?: string,
): Promise<ProjectInfo> {
  const repository = await githubService.getRepository(ctx, owner, repo, {
    withBranches: true,
  });
  const requestedBranch = branch?.trim();
  const selectedBranch = requestedBranch || repository.default_branch;

  if (requestedBranch) {
    const head = await githubService.getLatestCommit(ctx, owner, repo, selectedBranch);
    if (!head) {
      throw new Error(`Branch "${selectedBranch}" was not found for ${owner}/${repo}`);
    }
  }

  return resolveFromReader(
    createGitHubReader(ctx, owner, repo, selectedBranch),
    repository,
    selectedBranch,
  );
}

async function resolveFromGitLab(
  ctx: RequestContext,
  projectId: number,
  owner: string,
  repo: string,
  branch?: string,
): Promise<ProjectInfo> {
  const { getProject, listBranches } = await import("../gitlab/gitlab.service");
  const project = await getProject(ctx, projectId);
  const requestedBranch = branch?.trim();
  const selectedBranch = requestedBranch || project.defaultBranch || "main";

  if (requestedBranch) {
    const branches = await listBranches(ctx, projectId);
    if (!branches.some((b) => b.name === selectedBranch)) {
      throw new Error(`Branch "${selectedBranch}" was not found for ${owner}/${repo}`);
    }
  }

  const repository = {
    name: project.name,
    full_name: project.fullName,
    owner,
    private: project.private,
    default_branch: project.defaultBranch,
    clone_url: project.cloneUrl,
    html_url: project.htmlUrl,
    branches: (await listBranches(ctx, projectId)).map((b) => ({ name: b.name })),
  };

  return resolveFromReader(
    createGitLabReader(ctx, projectId, selectedBranch),
    repository,
    selectedBranch,
  );
}

function toProjectInfo(
  repo: {
    name: string;
    full_name: string;
    owner: string;
    private: boolean;
    default_branch: string;
    selected_branch?: string;
    clone_url?: string;
    html_url?: string;
    branches?: { name: string }[];
  },
  projectRoot: ProjectRootSnapshot,
  composeContent?: string,
  selectedBranch?: string,
  composeEnvContent?: string,
  monorepo?: { apps: MonorepoApp[]; workspace: MonorepoWorkspace } | null,
  routing?: RoutingConfig,
): ProjectInfo {
  const stack = projectRoot.stack;
  const rootEnv = composeEnvContent ? parseComposeEnvFile(composeEnvContent) : {};

  let services: ComposeService[] | undefined;
  if (composeContent && stack.projectType === "services") {
    try {
      const parsed = parseComposeFile(composeContent, { envFileContent: composeEnvContent });
      services = parsed.services;
    } catch {
      // Invalid YAML - continue without services.
    }
  }

  // Monorepo wins over the single-root projectType: when the root has a workspace
  // manifest AND we found 2+ deployable apps, expose the multi-app flow. The
  // `selected` root provides a single-app fallback if the user chooses to deploy
  // just one.
  const isMonorepo = !services && monorepo && monorepo.apps.length >= 2;
  const projectType: ProjectType = isMonorepo ? "monorepo" : stack.projectType;

  return {
    repository: {
      name: repo.name,
      full_name: repo.full_name,
      owner: { login: repo.owner },
      private: repo.private,
      default_branch: repo.default_branch,
      selected_branch: selectedBranch || repo.default_branch,
      clone_url: repo.clone_url,
      html_url: repo.html_url,
      branches: repo.branches,
    },
    stack: stack.stack,
    projectType,
    category: stack.category,
    packageManager: stack.packageManager,
    buildCommand: stack.buildCommand,
    installCommand: stack.installCommand,
    startCommand: stack.startCommand,
    buildImage: stack.buildImage,
    outputDirectory: stack.outputDirectory,
    rootDirectory: projectRoot.rootDirectory || "./",
    productionPaths: stack.productionPaths,
    port: stack.port,
    ...(services && { services }),
    ...(isMonorepo && monorepo
      ? { monorepoApps: monorepo.apps, monorepoWorkspace: monorepo.workspace }
      : {}),
    ...(Object.keys(rootEnv).length > 0 && { rootEnv }),
    ...(routing && { routing }),
  };
}
