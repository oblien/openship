/**
 * Prepare service - resolves project info from a source (GitHub or local path).
 *
 * Pure introspection: reads files, detects stack, returns a unified shape.
 * No database writes, no deployment logic.
 */

import * as githubService from "../github/github.service";
import type { RequestContext } from "../../lib/request-context";
import { MANIFEST_FILES, type RepoFile, type StackResult } from "../../lib/stack-detector";
import {
  parseComposeEnvFile,
  parseComposeFile,
  type ComposeMissingVariable,
  type ComposeService,
} from "../../lib/compose-parser";
import { maskEnv, maskScanService } from "../../lib/secret-env";
import {
  applyWorkspaceContext,
  buildProjectRootSnapshot,
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
  type OpenshipReadiness,
  type OpenshipMonorepoApp,
  type ComposeAdvanced,
  resolveTierResources,
} from "@repo/core";
import { env } from "../../config";
import { createGitHubReader, type ProjectReader } from "./project-reader";

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
      /** See {@link ResolveOptions.composePath}. */
      composePath?: string;
      /** See {@link ResolveOptions.env}. */
      env?: Record<string, string>;
    }
  | {
      source: "local";
      path: string;
      composePath?: string;
      /** See {@link ResolveOptions.env}. */
      env?: Record<string, string>;
    };

export interface ResolveOptions {
  /**
   * Where the compose file lives when it is NOT at the auto-detected project
   * root — either the file itself (`"deploy/stack.yml"`, which also covers
   * non-standard filenames) or the directory holding it
   * (`"deploy/docker-compose"`).
   *
   * Declaring this is an instruction, not a hint: root selection and monorepo
   * discovery are skipped, the project is a compose/services deploy, and a path
   * with no compose file is an error rather than a silent fall-back to a
   * buildpack build (the confusing behaviour this option exists to replace).
   */
  composePath?: string;
  /**
   * Env the caller already holds for this deploy (the values configured on the
   * project / entered in the wizard). Compose interpolation resolves against
   * these on top of the repo `.env`, so a file declaring `${VAR:?...}` scans
   * cleanly once the user has supplied VAR — without it the scan reports the
   * file as unparseable even though the deploy would have succeeded (#383).
   */
  env?: Record<string, string>;
}

/** Thrown when a declared `composePath` has no compose file behind it. */
class ComposePathNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposePathNotFoundError";
  }
}

/** Where a declared compose path points, before we've looked at the tree. */
interface DeclaredComposeTarget {
  /** Directory to snapshot, repo-relative ("" = the repo root). */
  directory: string;
  /** Filenames to accept in it, in priority order — exactly one for a file path. */
  candidates: string[];
}

/**
 * Split a declared compose path into "which directory" and "which filenames".
 * Pure — the caller does the single directory listing.
 *
 * File-vs-directory is decided by the YAML extension, NOT by the standard
 * compose filenames: matching only `docker-compose.yml`/`compose.yml` would treat
 * `deploy/stack.yml` as a directory of that name, losing the non-standard
 * filename support that is half the point of accepting a file path.
 */
function parseDeclaredComposePath(composePath: string): DeclaredComposeTarget {
  const normalized = normalizeProjectRootDirectory(composePath);
  const segments = normalized ? normalized.split("/") : [];

  // `..` can't be resolved against a repo we only have a listing for, and would
  // escape the checkout.
  if (segments.some((segment) => segment === "..")) {
    throw new ComposePathNotFoundError(
      `Compose path "${composePath}" must be inside the repository (no "..").`,
    );
  }

  const basename = segments.at(-1) ?? "";
  if (/\.ya?ml$/i.test(basename)) {
    return { directory: segments.slice(0, -1).join("/"), candidates: [basename] };
  }
  return { directory: normalized, candidates: [...COMPOSE_FILES] };
}

/** Pick the declared compose file out of its directory's listing, or explain why not. */
function pickDeclaredComposeFile(
  files: RepoFile[],
  target: DeclaredComposeTarget,
  composePath: string,
): string {
  const where = target.directory || ".";
  if (files.length === 0) {
    throw new ComposePathNotFoundError(
      `Compose path "${composePath}" was not found in the repository — "${where}" is empty or does not exist.`,
    );
  }

  const [match] = presentComposeFiles(files, target.candidates);
  if (!match) {
    throw new ComposePathNotFoundError(
      `No compose file found at "${composePath}" — looked for ${target.candidates.join(", ")} in "${where}".`,
    );
  }

  return match;
}

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
  /**
   * The compose path this resolution actually used, echoed back so the wizard can
   * show it and persist it — including when it came from `openship.json` rather
   * than the request. Absent when the root was detected the usual way.
   */
  composePath?: string;
  productionPaths: string[];
  /** Declared persistent mounts. Undefined = the project inherits the stack's
   *  `persistentPaths`; `[]` = the user opted out. */
  volumes?: string[];
  port: number;
  services?: ComposeService[];
  /** Compose variables the file marks mandatory that no `.env`/caller value
   *  satisfied — the wizard's list to prompt for. Absent when there are none. */
  missingRequiredEnv?: ComposeMissingVariable[];
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
  /**
   * Declared deploy-time readiness gate. SEEDS the wizard's Health section only —
   * absent here means the wizard shows it off (the default), which is also what
   * the pipeline does when the project has no `readiness`.
   */
  readiness?: OpenshipReadiness;
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
 * A declared `resources` block → the `advanced.resources` shape service rows
 * store. A `tier` resolves through the shared table; explicit cpu/memory win.
 * Returns undefined when nothing was declared (inherit the project).
 */
function toAdvancedResources(
  r: OpenshipResources | undefined,
): { cpuCores?: number; memoryMb?: number } | undefined {
  if (!r) return undefined;
  const base = r.tier ? resolveTierResources(r.tier) : undefined;
  const cpuCores = r.cpuCores ?? base?.cpuCores;
  const memoryMb = r.memoryMb ?? base?.memoryMb;
  if (cpuCores === undefined && memoryMb === undefined) return undefined;
  return {
    ...(cpuCores !== undefined && { cpuCores }),
    ...(memoryMb !== undefined && { memoryMb }),
  };
}

/**
 * Map declared `services[]` to the compose-service rows the deploy pipeline
 * persists. A declared service is a full compose definition, so this replaces
 * detection (the project becomes a `services` project). Healthcheck and
 * per-service resources map into the `advanced` JSONB blob, mirroring the
 * compose parser.
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
      ...(() => {
        // One `advanced` blob, built additively — a per-service `resources`
        // declaration must not be dropped just because healthcheck is absent
        // (and vice versa).
        const advanced: ComposeAdvanced = {};
        if (s.healthcheck) advanced.healthcheck = s.healthcheck;
        if (s.readiness) advanced.readiness = s.readiness;
        const res = toAdvancedResources(s.resources);
        if (res) advanced.resources = res;
        return Object.keys(advanced).length > 0 ? { advanced } : {};
      })(),
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
  // Declared `[]` is meaningful (persistence off), so test for presence, not truth.
  if (config.volumes) info.volumes = config.volumes;
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
  if (config.readiness) info.readiness = config.readiness;

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
    ...(result.composePath && { composePath: result.composePath }),
    productionPaths: result.productionPaths,
    port: result.port,
    // #336: env values (and their environmentMeta) are masked on output. The
    // deploy pipeline recovers the real values by re-parsing the source, and the
    // wizard reveals them on demand via the write-gated reveal endpoint.
    services: (result.services ?? []).map(maskScanService),
    ...(result.missingRequiredEnv && { missingRequiredEnv: result.missingRequiredEnv }),
    // Declared-overlay fields (openship.json) — omitted from the response when
    // absent so a repo without the file yields the exact same payload as before.
    ...(result.productionMode && { productionMode: result.productionMode }),
    ...(result.volumes && { volumes: result.volumes }),
    ...(result.runtimeMode && { runtimeMode: result.runtimeMode }),
    ...(result.publicEndpoints && { publicEndpoints: result.publicEndpoints }),
    ...(result.resources && { resources: result.resources }),
    ...(result.readiness && { readiness: result.readiness }),
    ...(result.rootEnv && Object.keys(result.rootEnv).length > 0 && { rootEnv: maskEnv(result.rootEnv) }),
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

/** Which of `candidates` this directory listing actually holds, in candidate order. */
function presentComposeFiles(files: RepoFile[], candidates: readonly string[]): string[] {
  return candidates.filter((candidate) =>
    files.some((file) => file.name.toLowerCase() === candidate.toLowerCase()),
  );
}

/** Read the first of `names` that yields content. Names are already known present. */
async function readComposeText(
  reader: ProjectReader,
  rootDirectory: string,
  names: string[],
): Promise<string | undefined> {
  for (const name of names) {
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
    return resolveFromGitHub(input.ctx, input.owner, input.repo, input.branch, {
      composePath: input.composePath,
      env: input.env,
    });
  }

  if (env.CLOUD_MODE) {
    throw new Error("Local project resolution is not available in cloud mode");
  }

  // Dynamic import keeps local-source (node:fs) out of the cloud module graph.
  const { resolveFromLocal } = await import("./local-source");
  return resolveFromLocal(input.path, { composePath: input.composePath, env: input.env });
}

type RepoMeta = Parameters<typeof toProjectInfo>[0];

/**
 * The project root we settled on, however we got there — the detector's pick or a
 * directory the user pinned. One shape for both so the read → map → overlay tail
 * below stays single-copy: only the RESOLUTION differs between the two paths.
 */
interface ResolvedProjectRoot {
  selected: ProjectRootSnapshot;
  monorepo: { apps: MonorepoApp[]; workspace: MonorepoWorkspace } | null;
  /** Compose filenames to read from, in order. Already confirmed present. */
  composeFiles: string[];
  /** The declared path, when there was one — pins projectType and rootDirectory. */
  declaredComposePath?: string;
}

/** Root by detection: score the candidate directories and probe for compose. */
async function resolveDetectedRoot(
  reader: ProjectReader,
  rootSnapshot: ProjectRootSnapshotInput,
): Promise<ResolvedProjectRoot> {
  const { selected, monorepo } = await selectProjectSnapshot(reader, rootSnapshot);
  return { selected, monorepo, composeFiles: presentComposeFiles(selected.files, COMPOSE_FILES) };
}

/**
 * Root by declaration. Skips `selectPreferredProjectRoot` and
 * `discoverMonorepoApps` on purpose: the user told us where the compose file is,
 * so there is nothing to infer and no sub-app flow to offer.
 */
async function resolveDeclaredRoot(
  reader: ProjectReader,
  composePath: string,
): Promise<ResolvedProjectRoot> {
  const target = parseDeclaredComposePath(composePath);
  // One listing serves both jobs — readProjectSnapshot lists this same directory.
  const snapshotInput = await readProjectSnapshot(reader, target.directory);
  const composeFile = pickDeclaredComposeFile(snapshotInput.files, target, composePath);

  return {
    selected: buildProjectRootSnapshot(snapshotInput),
    monorepo: null,
    composeFiles: [composeFile],
    declaredComposePath: composePath,
  };
}

/**
 * Shared resolution pipeline: snapshot → resolve root → read compose/.env → map.
 * Source-specific work (auth, branch validation, fs stat) lives in the callers.
 */
export async function resolveFromReader(
  reader: ProjectReader,
  repoMeta: RepoMeta,
  selectedBranch: string,
  opts: ResolveOptions = {},
): Promise<ProjectInfo> {
  const rootSnapshot = await readProjectSnapshot(reader);
  const routing = extractRootRouting(rootSnapshot.fileContents ?? {});
  const openshipConfig = extractOpenshipConfig(rootSnapshot.fileContents ?? {});

  // Configs SEED defaults; an explicit caller value — the user's own edit,
  // persisted on the project — wins over the repo-declared one. Resolved before
  // the root so a declared path can pre-empt detection; the overlay applied at
  // the end of this function is far too late to relocate the compose read.
  const declaredComposePath = opts.composePath?.trim() || openshipConfig?.composePath?.trim();
  const root = declaredComposePath
    ? await resolveDeclaredRoot(reader, declaredComposePath)
    : await resolveDetectedRoot(reader, rootSnapshot);

  // `.env` sits next to the compose file, which is what compose itself resolves
  // against — for a declared root that is the pinned directory, not the repo root.
  const [composeContent, composeEnvContent] = await Promise.all([
    readComposeText(reader, root.selected.rootDirectory, root.composeFiles),
    readProjectText(reader, root.selected.rootDirectory, ".env"),
  ]);
  if (root.declaredComposePath && !composeContent) {
    throw new ComposePathNotFoundError(
      `Compose file "${root.composeFiles[0]}" at "${root.selected.rootDirectory || "."}" could not be read.`,
    );
  }

  const info = toProjectInfo(
    repoMeta,
    root.selected,
    composeContent,
    selectedBranch,
    composeEnvContent,
    root.monorepo,
    routing,
    { declaredCompose: !!root.declaredComposePath, env: opts.env },
  );
  const overlaid = applyOpenshipOverlay(info, openshipConfig);

  if (root.declaredComposePath) {
    // The compose directory IS this project's root — it anchors every relative
    // `build:` context. Re-pin it after the overlay so a stray `rootDirectory` in
    // openship.json can't desync the two and send builds at the wrong folder.
    overlaid.rootDirectory = root.selected.rootDirectory || "./";
    overlaid.composePath = root.declaredComposePath;
  }
  return overlaid;
}

async function resolveFromGitHub(
  ctx: RequestContext,
  owner: string,
  repo: string,
  branch?: string,
  opts: ResolveOptions = {},
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
    opts,
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
  opts?: {
    /** The caller resolved a declared `composePath`: parse + classify as a
     *  services project even when stack detection wouldn't say so on its own
     *  (a non-standard filename like `stack.yml` matches no root marker). */
    declaredCompose?: boolean;
    /** See {@link ResolveOptions.env}. */
    env?: Record<string, string>;
  },
): ProjectInfo {
  const stack = projectRoot.stack;
  const rootEnv = composeEnvContent ? parseComposeEnvFile(composeEnvContent) : {};

  let services: ComposeService[] | undefined;
  let missingRequiredEnv: ComposeMissingVariable[] | undefined;
  if (composeContent && (opts?.declaredCompose || stack.projectType === "services")) {
    try {
      const parsed = parseComposeFile(composeContent, {
        envFileContent: composeEnvContent,
        env: opts?.env,
      });
      services = parsed.services;
      // Values the file demands (`${VAR:?…}`) that nothing here supplied. NOT an
      // error: the scan runs before the user has filled the wizard's env form, so
      // this is the list to prompt for, not a reason to refuse the repo (#472).
      if (parsed.missingRequired.length > 0) missingRequiredEnv = parsed.missingRequired;
    } catch (err) {
      // Surface the broken file — an unusable file (invalid YAML), which is all
      // the parser throws for now. Swallowing it returns a services project with
      // ZERO services — the wizard then shows nothing to deploy and no reason
      // why (issue #339). True whether the path was declared or detected: we
      // only parse when compose IS this root's stack.
      const detail = err instanceof Error && err.message ? err.message : "Unknown parser error";
      const where = opts?.declaredCompose ? ` at "${projectRoot.rootDirectory || "."}"` : "";
      throw new Error(`Could not parse the Docker Compose file${where}: ${detail}`, { cause: err });
    }
  }

  // Monorepo wins over the single-root projectType: when the root has a workspace
  // manifest AND we found 2+ deployable apps, expose the multi-app flow. The
  // `selected` root provides a single-app fallback if the user chooses to deploy
  // just one.
  const isMonorepo = !services && monorepo && monorepo.apps.length >= 2;
  const projectType: ProjectType = opts?.declaredCompose
    ? "services"
    : isMonorepo
      ? "monorepo"
      : stack.projectType;

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
    // detectPackageManager()'s "unknown" fallback (no manifest anywhere in this
    // root) is an internal sentinel, not a real package manager — PackageManagerEnum
    // (project.schema.ts) never included it, so echoing it back verbatim here let
    // the client round-trip it straight into project creation and 400 with
    // "Expected union value" (issue #415). "npm" mirrors the client's own
    // `|| "npm"` fallback default (DEFAULT_DEPLOYMENT_CONFIG) — same reasonable
    // default, now applied where the value is actually produced.
    packageManager: stack.packageManager === "unknown" ? "npm" : stack.packageManager,
    buildCommand: stack.buildCommand,
    installCommand: stack.installCommand,
    startCommand: stack.startCommand,
    buildImage: stack.buildImage,
    outputDirectory: stack.outputDirectory,
    rootDirectory: projectRoot.rootDirectory || "./",
    productionPaths: stack.productionPaths,
    port: stack.port,
    ...(services && { services }),
    ...(missingRequiredEnv && { missingRequiredEnv }),
    ...(isMonorepo && monorepo
      ? { monorepoApps: monorepo.apps, monorepoWorkspace: monorepo.workspace }
      : {}),
    ...(Object.keys(rootEnv).length > 0 && { rootEnv }),
    ...(routing && { routing }),
  };
}
