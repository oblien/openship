"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { EnvironmentVariable, FrameworkId } from "@/components/import-project/types";
import { deployApi, projectsApi, servicesApi, serviceKind } from "@/lib/api";
import { folderApi } from "@/lib/api/folder";
import type { PrepareProjectResponse, PrepareComposeService, PrepareMonorepoApp } from "@/lib/api/deploy";
import type { Service } from "@/lib/api/services";
import { ApiError, getApiErrorMessage } from "@/lib/api/client";
import { settingsApi } from "@/lib/api/settings";
import type { BuildMode } from "@/lib/api/settings";
import { STACKS, getBuildImage, type StackDefinition, type StackId } from "@repo/core";
import type { BuildStrategy, DeploymentConfig, DeploymentModeSnapshot, MonorepoAppConfig, MonorepoWorkspaceConfig, PublicEndpoint } from "./types";
import {
  DEFAULT_CONFIG,
  createPublicEndpoint,
  ensurePublicEndpoints,
  normalizeComposeService,
  syncPublicEndpointState,
} from "./types";
import {
  buildSingleModeSnapshot,
  syncActiveModeSnapshot,
} from "./mode-config";
import { normalizeSubdomain } from "@/utils/subdomain";
import { useDefaultDomainType } from "@/context/CloudContext";

type PersistedProject = Record<string, any> | null;

interface PreparedConfigArgs {
  response: PrepareProjectResponse;
  project: PersistedProject;
  repoName: string;
  owner: string;
  branch: string;
  branches: string[];
  projectId?: string;
  localPath?: string;
  uploadSessionId?: string;
}

interface PreparedProjectContext {
  projectType: DeploymentConfig["projectType"];
  serviceDeploymentMode: DeploymentConfig["serviceDeploymentMode"];
  detectedStack: FrameworkId;
  stackDef: StackDefinition | undefined;
  singleAppCandidate: PrepareProjectResponse["singleAppCandidate"];
  singleStackDef: StackDefinition | undefined;
  composeDefaults: DeploymentConfig["composeDefaults"];
  preparedOptions: DeploymentConfig["options"];
  monorepoApps?: MonorepoAppConfig[];
  monorepoWorkspace?: MonorepoWorkspaceConfig;
}

function buildMonorepoApps(
  response: PrepareProjectResponse,
  domainType: "free" | "custom",
): MonorepoAppConfig[] | undefined {
  if (!response.monorepoApps?.length) return undefined;

  return response.monorepoApps.map((app): MonorepoAppConfig => {
    const detectedFramework = (app.stack || "unknown") as FrameworkId;
    const hasServer = !!app.startCommand;
    const hasBuild = !!app.buildCommand;
    const portString = app.port ? String(app.port) : "";

    return {
      id: app.id || app.rootDirectory,
      name: app.name || app.rootDirectory.split("/").at(-1) || app.rootDirectory,
      enabled: true,
      framework: detectedFramework,
      detectedFramework,
      packageManager: app.packageManager || response.packageManager || "npm",
      buildImage: app.buildImage || response.buildImage || "node:22",
      rootDirectory: app.rootDirectory,
      installCommand: app.installCommand || "",
      buildCommand: app.buildCommand || "",
      startCommand: app.startCommand || "",
      outputDirectory: app.outputDirectory || "",
      productionPaths: app.productionPaths || [],
      port: portString,
      hasServer,
      hasBuild,
      envVars: [],
      publicEndpoints: ensurePublicEndpoints(
        undefined,
        hasServer ? { port: portString, domainType } : { targetPath: "/", domainType },
      ),
    };
  });
}

function buildMonorepoWorkspace(response: PrepareProjectResponse): MonorepoWorkspaceConfig | undefined {
  if (!response.monorepoWorkspace) return undefined;
  return {
    packageManager: response.monorepoWorkspace.packageManager || "npm",
    prepareCommand: response.monorepoWorkspace.prepareCommand || "",
  };
}

interface PreparedRoutingState {
  effectiveHasServer: boolean;
  primaryPort: string;
  hasStoredPort: boolean;
  publicEndpoints: DeploymentConfig["publicEndpoints"];
}

interface PreparedRuntimeConfig {
  packageManager: string;
  buildImage: string;
  options: DeploymentConfig["options"];
}

function envMapToRows(env?: Record<string, string>): DeploymentConfig["envVars"] {
  return Object.entries(env ?? {}).map(([key, value]) => ({
    key,
    value,
    visible: true, // show values as entered; eye toggles to hide
  }));
}

/**
 * The compose pin to scan with: the caller's value, else whatever the saved
 * project already has. The latter is what makes re-entering the wizard on a
 * subpath-compose project detect it the same way it did the first time, instead
 * of falling back to a single-app read of the repo root.
 *
 * Returns a `{ composePath }` fragment to spread into the prepare body — empty
 * when there is nothing to pin, and for `""` (an explicit clear), so a blank
 * value never reaches the API as a pin.
 */
function scanComposePath(
  contextComposePath: string | undefined,
  project: PersistedProject,
): { composePath?: string } {
  const declared =
    contextComposePath ??
    (typeof project?.composePath === "string" ? project.composePath : undefined);
  const trimmed = declared?.trim();
  return trimmed ? { composePath: trimmed } : {};
}

/**
 * The env the scan should interpolate the compose file against (#383). A compose
 * file declaring `${VAR:?...}` is unparseable until VAR has a value, so a re-scan
 * has to carry what the user already entered — otherwise the wizard reports the
 * file as broken even though the deploy itself would resolve the same variable.
 *
 * Returns an `{ env }` fragment to spread into the prepare body, empty when
 * nothing is set so a blank map never reaches the API.
 */
function scanEnv(envVars: EnvironmentVariable[]): { env?: Record<string, string> } {
  const env: Record<string, string> = {};
  for (const { key, value } of envVars) {
    const name = key.trim();
    if (name) env[name] = value;
  }
  return Object.keys(env).length > 0 ? { env } : {};
}

function hasSavedProjectPort(project: PersistedProject) {
  if (!project) return false;

  if (typeof project.port === "number") return true;

  if (typeof project.options?.productionPort === "string" && project.options.productionPort.trim()) {
    return true;
  }

  return Array.isArray(project.publicEndpoints)
    ? project.publicEndpoints.some((endpoint: any) => {
        if (endpoint?.port === undefined || endpoint?.port === null) return false;
        return String(endpoint.port).trim().length > 0;
      })
    : false;
}

// Reading a SAVED project's endpoints into the wizard. Every routing field has to
// survive the trip: the deploy sends this list back, and an omitted redirect CLEARS
// the stored one — so dropping it here would make a redeploy quietly turn a
// redirecting domain back into one that serves the app.
function mapStoredPublicEndpoints(project: PersistedProject) {
  return project?.publicEndpoints?.map((endpoint: {
    port?: number;
    targetPath?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
    redirectTo?: string;
    redirectStatus?: number;
  }) => createPublicEndpoint({
    port: endpoint.port ? String(endpoint.port) : "",
    targetPath: endpoint.targetPath || "",
    domain: endpoint.domain || "",
    customDomain: endpoint.customDomain || "",
    domainType: endpoint.domainType || "free",
    redirectTo: endpoint.redirectTo || undefined,
    redirectStatus: endpoint.redirectStatus || undefined,
  }));
}

/**
 * Seed the single-app public-endpoint list: start from whatever the project
 * already saved, then guarantee at least one primary endpoint on the free
 * subdomain — a port for a server app, a "/" path for a static one. Shared by
 * the prepare path (resolvePreparedRoutingState) and the saved-only config-edit
 * path (initializeFromProject) so the two can't drift. `primaryDomain` is passed
 * in because the prepare path also needs it for the monorepo branch.
 */
function buildSingleAppEndpoints(
  project: PersistedProject,
  primaryDomain: string,
  hasServer: boolean,
  port: string,
  domainType: "free" | "custom",
): PublicEndpoint[] {
  return ensurePublicEndpoints(
    mapStoredPublicEndpoints(project),
    hasServer
      ? { port, domain: primaryDomain, domainType }
      : { targetPath: "/", domain: primaryDomain, domainType },
  );
}

function buildPreparedOptions(response: PrepareProjectResponse): DeploymentConfig["options"] {
  // Declared productionMode wins: "static" is serverless; "host"/"standalone"
  // always run a server. Absent → derive from the detected start command.
  const hasServer = response.productionMode
    ? response.productionMode !== "static"
    : !!response.startCommand;
  const hasBuild = !!response.buildCommand;

  return {
    buildCommand: response.buildCommand ?? "",
    installCommand: response.installCommand ?? "",
    outputDirectory: response.outputDirectory ?? "",
    productionPaths: response.productionPaths.join(", "),
    startCommand: response.startCommand ?? "",
    productionPort: hasServer ? String(response.port ?? "") : "",
    rootDirectory: response.rootDirectory || "./",
    hasServer,
    hasBuild,
  };
}

/**
 * Map a declared `resources` block (openship.json) to the deploy config's cloud
 * tier fields. A named tier maps straight through; explicit cpu/mem/disk becomes
 * the "custom" tier (missing values fall back to low-tier defaults). Returns an
 * empty object when nothing is declared, so the config keeps its default tier.
 *
 * `unlimited` is deliberately NOT forwarded: it's a self-hosted-only selection
 * (the machine is the cap) and has no cloud spec, so passing it through would
 * reach the provisioner as a tier with no cpu/memory behind it. A repo that
 * declares it simply keeps the cloud default here.
 */
function resolveCloudResources(
  resources: PrepareProjectResponse["resources"],
): Partial<Pick<DeploymentConfig, "cloudResourceTier" | "cloudResourceCustom">> {
  if (!resources) return {};
  if (resources.tier && resources.tier !== "unlimited") {
    return { cloudResourceTier: resources.tier };
  }
  if (resources.cpuCores != null || resources.memoryMb != null || resources.diskMb != null) {
    return {
      cloudResourceTier: "custom",
      cloudResourceCustom: {
        cpuCores: resources.cpuCores ?? 1,
        memoryMb: resources.memoryMb ?? 1024,
        diskMb: resources.diskMb ?? 16384,
      },
    };
  }
  return {};
}

function buildComposeDefaults(
  response: PrepareProjectResponse,
  detectedStack: FrameworkId,
): NonNullable<DeploymentConfig["composeDefaults"]> {
  return {
    framework: detectedStack,
    packageManager: response.packageManager || "npm",
    buildImage: response.buildImage || "node:22",
    options: {
      ...buildPreparedOptions(response),
      productionPort: "",
    },
  };
}

/**
 * Reconstruct a prepare-shaped response from SAVED project + service data.
 *
 * This is the seam that lets the config-edit path (initializeFromProject)
 * hydrate through the exact SAME `buildPreparedConfig` core the repo/local
 * detection paths use — the only difference is the DATA SOURCE (saved DB rows
 * vs a live repo scan). That keeps single-app, services, and monorepo edits on
 * one code path AND means editing never re-clones the repo or collapses a
 * DB-defined compose stack to a single app because the repo has no compose file.
 */
function buildSavedProjectResponse(
  project: NonNullable<PersistedProject>,
  services: Service[],
): PrepareProjectResponse {
  // Derive the shape from the ACTUAL saved service rows (monorepo wins, then
  // compose), not the getInfo-provided `projectType` field — a compose project
  // whose rows exist must hydrate as "services" even if that derived field is
  // stale/absent. `serviceKind` treats a null `kind` as compose, matching the
  // rest of the app. Fall back to the field, then "app", only when there are
  // no service rows at all.
  const monorepoRows = services.filter((s) => serviceKind(s) === "monorepo");
  const composeRows = services.filter((s) => serviceKind(s) === "compose");
  const projectType: PrepareProjectResponse["projectType"] = monorepoRows.length
    ? "monorepo"
    : composeRows.length
      ? "services"
      : ((project.projectType as PrepareProjectResponse["projectType"]) || "app");
  const opts = project.options ?? {};
  const productionPaths: string[] = Array.isArray(opts.productionPaths)
    ? opts.productionPaths
    : typeof opts.productionPaths === "string" && opts.productionPaths.trim()
      ? opts.productionPaths.split(",").map((p: string) => p.trim()).filter(Boolean)
      : [];

  const composeServices: PrepareComposeService[] = composeRows.map(normalizeComposeService);

  const monorepoApps: PrepareMonorepoApp[] = monorepoRows
    .map((s) => ({
      id: s.id,
      name: s.name,
      rootDirectory: s.rootDirectory ?? "",
      stack: (s.framework ?? "unknown") as StackId,
      category: "",
      packageManager: s.packageManager ?? project.packageManager ?? "npm",
      buildCommand: s.buildCommand ?? "",
      installCommand: s.installCommand ?? "",
      startCommand: s.startCommand ?? "",
      buildImage: s.buildImage ?? "",
      outputDirectory: s.outputDirectory ?? "",
      productionPaths: [],
      port: s.exposedPort ? Number(s.exposedPort) || 0 : 0,
    }));

  const branchName = typeof project.gitBranch === "string" ? project.gitBranch : "main";

  return {
    stack: (project.framework as StackId) || "nextjs",
    projectType,
    category: "",
    packageManager: project.packageManager || "npm",
    buildCommand: opts.buildCommand ?? "",
    installCommand: opts.installCommand ?? "",
    startCommand: opts.startCommand ?? "",
    buildImage: project.buildImage || "node:22",
    outputDirectory: opts.outputDirectory ?? "",
    rootDirectory: opts.rootDirectory ?? "./",
    productionPaths,
    port: typeof project.port === "number" ? project.port : Number(opts.productionPort) || 0,
    hasServer: opts.hasServer ?? project.hasServer ?? true,
    hasBuild: opts.hasBuild ?? true,
    repository: {
      name: project.gitRepo || project.name || "project",
      full_name:
        project.gitOwner && project.gitRepo
          ? `${project.gitOwner}/${project.gitRepo}`
          : project.name || "project",
      owner: { login: project.gitOwner || "local" },
      private: false,
      default_branch: branchName,
      selected_branch: branchName,
      branches: [{ name: branchName }],
    },
    services: composeServices,
    monorepoApps: monorepoApps.length ? monorepoApps : undefined,
    monorepoWorkspace: project.monorepoWorkspace
      ? {
          packageManager: project.monorepoWorkspace.packageManager || project.packageManager || "npm",
          prepareCommand: project.monorepoWorkspace.prepareCommand || "",
        }
      : undefined,
    rootEnv: {},
  };
}

function resolvePreparedProjectContext(
  response: PrepareProjectResponse,
  domainType: "free" | "custom",
): PreparedProjectContext {
  const projectType = response.projectType || "app";
  // Multi-app projects (compose services AND monorepos) default to separate
  // per-app runtimes ("services"), in BOTH cloud and self-hosted - it's the
  // non-lossy shape (every app actually runs). Cloud may later default monorepos
  // to a unified single deployment; branch on platform (usePlatform().selfHosted)
  // here when that runtime lands. Single apps stay "single".
  const serviceDeploymentMode =
    projectType === "services" || projectType === "monorepo" ? "services" : "single";
  const detectedStack = (response.stack || "nextjs") as FrameworkId;
  const stackDef = STACKS[detectedStack as keyof typeof STACKS] as StackDefinition | undefined;
  const singleAppCandidate = response.singleAppCandidate;
  const singleStackDef = singleAppCandidate
    ? (STACKS[singleAppCandidate.stack as keyof typeof STACKS] as StackDefinition | undefined)
    : undefined;
  const composeDefaults = projectType === "services"
    ? buildComposeDefaults(response, detectedStack)
    : undefined;
  const monorepoApps = projectType === "monorepo" ? buildMonorepoApps(response, domainType) : undefined;
  const monorepoWorkspace = projectType === "monorepo" ? buildMonorepoWorkspace(response) : undefined;

  return {
    projectType,
    serviceDeploymentMode,
    detectedStack,
    stackDef,
    singleAppCandidate,
    singleStackDef,
    composeDefaults,
    preparedOptions: composeDefaults?.options ?? buildPreparedOptions(response),
    monorepoApps,
    monorepoWorkspace,
  };
}

function resolvePreparedRoutingState(
  response: PrepareProjectResponse,
  project: PersistedProject,
  repoName: string,
  context: Pick<PreparedProjectContext, "projectType" | "preparedOptions" | "monorepoApps">,
  domainType: "free" | "custom",
): PreparedRoutingState {
  const effectiveHasServer = context.projectType === "services"
    ? context.preparedOptions.hasServer
    : project?.hasServer ?? context.preparedOptions.hasServer;
  const primaryDomain = project?.slug || normalizeSubdomain(repoName);
  const primaryPort = context.projectType === "services"
    ? context.preparedOptions.productionPort
    : String(project?.port ?? response.port ?? "");
  const hasStoredPort = context.projectType === "services" ? false : hasSavedProjectPort(project);

  // Monorepo: seed one PublicEndpoint per detected sub-app so the
  // existing `<PublicEndpointsCard>` in the sidebar renders all of them
  // as separate Domain cards (the card's `+` button already supports
  // multiple endpoints - we just need to seed the array). Each entry
  // uses `{appName}-{projectSlug}` as the free-subdomain label and the
  // sub-app's port; user can flip to a custom domain per entry the same
  // way the single-app flow already supports.
  if (context.projectType === "monorepo" && context.monorepoApps?.length) {
    const slugify = (v: string) =>
      v.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    const stored: PublicEndpoint[] = mapStoredPublicEndpoints(project) ?? [];
    const seeded = context.monorepoApps.map((app) => {
      const label = `${slugify(app.name)}-${slugify(primaryDomain)}`;
      // Inherit if the user already saved a per-app endpoint for this
      // sub-app (matched by domain label). Otherwise auto-derive.
      const prior = stored.find((s: PublicEndpoint) => s.domain === label);
      return createPublicEndpoint({
        ...(prior ?? {}),
        port: app.port || "",
        targetPath: app.hasServer ? "" : "/",
        domain: label,
        domainType,
      });
    });
    return {
      effectiveHasServer,
      primaryPort,
      hasStoredPort,
      publicEndpoints: seeded,
    };
  }

  // Declared domains (openship.json) seed the single-app endpoints, unless the
  // project was already saved with its own (a config edit shouldn't be clobbered).
  if (response.publicEndpoints?.length && !mapStoredPublicEndpoints(project)?.length) {
    return {
      effectiveHasServer,
      primaryPort,
      hasStoredPort,
      publicEndpoints: response.publicEndpoints.map((e) =>
        createPublicEndpoint({
          domain: e.domain ?? "",
          customDomain: e.customDomain ?? "",
          domainType: e.domainType ?? (e.customDomain ? "custom" : "free"),
          port: e.port != null ? String(e.port) : effectiveHasServer ? primaryPort : "",
          targetPath: e.targetPath ?? (effectiveHasServer ? "" : "/"),
        }),
      ),
    };
  }

  return {
    effectiveHasServer,
    primaryPort,
    hasStoredPort,
    publicEndpoints: buildSingleAppEndpoints(
      project,
      primaryDomain,
      effectiveHasServer,
      primaryPort,
      domainType,
    ),
  };
}

function resolvePreparedRuntimeConfig(
  response: PrepareProjectResponse,
  project: PersistedProject,
  context: Pick<PreparedProjectContext, "composeDefaults" | "preparedOptions">,
  routing: Pick<PreparedRoutingState, "effectiveHasServer" | "primaryPort">,
): PreparedRuntimeConfig {
  if (context.composeDefaults) {
    return {
      packageManager: context.composeDefaults.packageManager,
      buildImage: context.composeDefaults.buildImage,
      options: {
        ...context.composeDefaults.options,
        productionPort: routing.primaryPort,
      },
    };
  }

  return {
    packageManager: project?.packageManager || response.packageManager || "npm",
    buildImage: project?.buildImage || response.buildImage || "node:22",
    options: {
      buildCommand: project?.buildCommand ?? response.buildCommand ?? "",
      installCommand: project?.installCommand ?? response.installCommand ?? "",
      outputDirectory: project?.outputDirectory ?? response.outputDirectory ?? "",
      productionPaths: project?.productionPaths ?? response.productionPaths.join(", "),
      startCommand: project?.startCommand ?? response.startCommand ?? "",
      productionPort: routing.primaryPort,
      rootDirectory: project?.rootDirectory || response.rootDirectory || "./",
      hasServer: routing.effectiveHasServer,
      hasBuild: project?.hasBuild ?? context.preparedOptions.hasBuild,
    },
  };
}

function resolvePreparedSingleModeDefaults(
  context: Pick<PreparedProjectContext, "singleAppCandidate" | "singleStackDef">,
  normalizeBuildStrategy: (projectType: DeploymentConfig["projectType"], stackDef: StackDefinition | undefined) => BuildStrategy,
  normalizeRuntimeMode: (projectType: DeploymentConfig["projectType"]) => DeploymentConfig["runtimeMode"],
): Pick<DeploymentModeSnapshot, "buildStrategy" | "runtimeMode"> | undefined {
  if (!context.singleAppCandidate) {
    return undefined;
  }

  return {
    buildStrategy: normalizeBuildStrategy(context.singleAppCandidate.projectType, context.singleStackDef),
    runtimeMode: normalizeRuntimeMode(context.singleAppCandidate.projectType),
  };
}

/**
 * Owns the deployment configuration state and prepare logic.
 *
 * Prepare = resolve project info from a source (GitHub repo or local path),
 * detect stack, and populate config with defaults.
 *
 * The user's global build mode preference (from settings) is fetched once
 * and used as the initial default for buildStrategy - but the per-deploy
 * value in config is the sole source of truth sent to the API.
 */
export function useDeploymentConfig() {
  const [config, setConfig] = useState<DeploymentConfig>(DEFAULT_CONFIG);
  const userBuildPref = useRef<BuildMode>("auto");
  // Free subdomains need Cloud, so a Cloud-less self-hosted instance seeds new
  // endpoints as custom instead of offering a `.opsh.io` name preflight rejects.
  const newEndpointDomainType = useDefaultDomainType();

  const normalizeConfig = useCallback((next: DeploymentConfig): DeploymentConfig => {
    return syncActiveModeSnapshot(syncPublicEndpointState(next));
  }, []);

  const normalizePreparedConfig = useCallback(
    (
      next: DeploymentConfig,
      singleModeDefaults?: Pick<DeploymentModeSnapshot, "buildStrategy" | "runtimeMode">,
    ): DeploymentConfig => {
      const normalized = normalizeConfig(next);

      // Auto-snapshot the single-mode shape for any multi-app project
      // (compose services OR monorepo sub-apps). When the operator
      // later flips the deployment-mode toggle, the snapshot is
      // restored without rebuilding from scratch.
      if (normalized.projectType !== "services" && normalized.projectType !== "monorepo") {
        return normalized;
      }

      const singleSnapshot = buildSingleModeSnapshot(normalized, singleModeDefaults);
      if (!singleSnapshot) {
        return normalized;
      }

      return {
        ...normalized,
        modeSnapshots: {
          ...normalized.modeSnapshots,
          single: singleSnapshot,
        },
      };
    },
    [normalizeConfig],
  );

  // Fetch user's global build mode preference once
  useEffect(() => {
    settingsApi.get().then((res) => {
      if (res?.buildMode) userBuildPref.current = res.buildMode;
    }).catch(() => { /* non-critical - fall back to stack default */ });
  }, []);

  const updateConfig = useCallback((updates: Partial<DeploymentConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...updates };
      return normalizeConfig(next);
    });
  }, [normalizeConfig]);

  const updateOptions = useCallback((updates: Partial<DeploymentConfig["options"]>) => {
    setConfig((prev) => {
      const next = { ...prev, options: { ...prev.options, ...updates } };
      return normalizeConfig(next);
    });
  }, [normalizeConfig]);

  /** Resolve the seed buildStrategy. An explicit global pref (Settings) wins;
   *  otherwise default to "server" — UNIFIED BUILD, i.e. build where you deploy.
   *  The wizard's target-aware preselect then confirms this per target (a bare
   *  local target builds locally, a server/cloud target builds remotely with a
   *  clone-on-server via git-credential forwarding). Matches the API default
   *  (settings.service resolves the same "server" fallback). docker/services are
   *  coerced to "server" in normalizeBuildStrategy; cloud is forced downstream. */
  const resolveInitialStrategy = useCallback((stackDef: StackDefinition | undefined): BuildStrategy => {
    const pref = userBuildPref.current;
    if (pref === "server" || pref === "local") return pref;
    return stackDef?.defaultBuildStrategy ?? "server";
  }, []);

  const normalizeBuildStrategy = useCallback(
    (projectType: DeploymentConfig["projectType"], stackDef: StackDefinition | undefined): BuildStrategy => {
      if (projectType === "docker" || projectType === "services") {
        return "server";
      }
      return resolveInitialStrategy(stackDef);
    },
    [resolveInitialStrategy],
  );

  const normalizeRuntimeMode = useCallback(
    (projectType: DeploymentConfig["projectType"]): DeploymentConfig["runtimeMode"] => {
      if (projectType === "docker" || projectType === "services") {
        return "docker";
      }
      return DEFAULT_CONFIG.runtimeMode;
    },
    [],
  );

  const buildPreparedConfig = useCallback(
    (
      prev: DeploymentConfig,
      args: PreparedConfigArgs,
    ): DeploymentConfig => {
      const {
        response,
        project,
        repoName,
        owner,
        branch,
        branches,
        projectId,
        localPath,
        uploadSessionId,
      } = args;
      const preparedContext = resolvePreparedProjectContext(response, newEndpointDomainType);
      const routingState = resolvePreparedRoutingState(
        response,
        project,
        repoName,
        preparedContext,
        newEndpointDomainType,
      );
      const runtimeConfig = resolvePreparedRuntimeConfig(
        response,
        project,
        preparedContext,
        routingState,
      );

      return normalizePreparedConfig({
        ...prev,
        projectId,
        repo: repoName,
        owner,
        localPath,
        uploadSessionId,
        projectName: project?.name || repoName,
        // The scan echoes back the compose path it actually used (request value or
        // the one openship.json declared), so the field shows what's in effect and
        // the value survives into the project row on save.
        composePath: response.composePath ?? (project?.composePath as string | undefined),
        projectType: preparedContext.projectType,
        serviceDeploymentMode: preparedContext.serviceDeploymentMode,
        composeDefaults: preparedContext.composeDefaults,
        singleAppCandidate: preparedContext.singleAppCandidate,
        monorepoApps: preparedContext.monorepoApps,
        monorepoWorkspace: preparedContext.monorepoWorkspace,
        routingConfig: response.routing ?? undefined,
        // Readiness gate. Same hydration rule as framework/runtimeMode: an
        // EXISTING project keeps its SAVED value so a config-save can't silently
        // clear a gate the operator turned on; a brand-new deploy honours what
        // openship.json declared. Neither present ⇒ undefined ⇒ off.
        readiness: projectId
          ? (project?.readiness ?? undefined)
          : (response.readiness ?? undefined),
        modeSnapshots: undefined,
        // For an EXISTING project (projectId set — config edit or redeploy)
        // prefer the SAVED framework so a fresh re-detection can't silently
        // rewrite it on save. Fall back to detection for a brand-new deploy
        // (or if the saved value is somehow missing). detectedFramework stays
        // the fresh detection for informational/UI purposes.
        framework:
          projectId && project?.framework ? project.framework : preparedContext.detectedStack,
        detectedFramework: preparedContext.detectedStack,
        buildStrategy: normalizeBuildStrategy(preparedContext.projectType, preparedContext.stackDef),
        // Same hydration rule as framework: for an EXISTING project keep the
        // SAVED runtime isolation so a config-save can't silently rewrite a
        // chosen "docker" back to the "bare" default. resolvePreparedRuntimeConfig
        // hydrates every OTHER options field from the project but not this one,
        // so without this the wizard would re-send the default and clobber it.
        //
        // When the column is UNSET (legacy projects — 0021 added runtime_mode
        // nullable with no backfill), default an existing project to "docker":
        // the historical default runtime was the sandbox, so an un-chosen project
        // must NOT be silently downgraded to Direct-on-host (bare) on save. Only
        // brand-new deploys (no projectId) use the projectType-derived default.
        runtimeMode:
          projectId && (project?.runtimeMode === "bare" || project?.runtimeMode === "docker")
            ? project.runtimeMode
            : projectId
              ? "docker"
              // Brand-new deploy: honor a declared runtime (openship.json) for a
              // single app; services/docker stay pinned to "docker" by normalize.
              : response.runtimeMode &&
                  preparedContext.projectType !== "services" &&
                  preparedContext.projectType !== "docker"
                ? response.runtimeMode
                : normalizeRuntimeMode(preparedContext.projectType),
        packageManager: runtimeConfig.packageManager,
        buildImage: runtimeConfig.buildImage,
        branch,
        branches,
        services: response.services || [],
        publicEndpoints: routingState.publicEndpoints,
        rootEnvVars: envMapToRows(response.rootEnv),
        productionPortTouched: routingState.hasStoredPort,
        lastAutoDetectedEnvPort: null,
        options: runtimeConfig.options,
        // Declared cloud sizing (openship.json). Absent → keep the default tier.
        ...resolveCloudResources(response.resources),
      }, resolvePreparedSingleModeDefaults(
        preparedContext,
        normalizeBuildStrategy,
        normalizeRuntimeMode,
      ));
    },
    [normalizeBuildStrategy, normalizePreparedConfig, normalizeRuntimeMode],
  );

  // ── Prepare from GitHub repo ───────────────────────────────────────────────

  const initializeFromRepo = useCallback(
    async (
      owner: string,
      repo: string,
      force?: string,
      context?: {
        branch?: string;
        projectId?: string;
        composePath?: string;
        env?: Record<string, string>;
      },
    ): Promise<{ success: boolean; error?: string; errorType?: string; buildInProgress?: boolean }> => {
      try {
        let project: PersistedProject = null;

        if (context?.projectId) {
          const projectResponse = await projectsApi.getInfo(context.projectId);
          project = projectResponse?.data?.project ?? projectResponse?.project ?? null;

          if (!project) {
            return {
              success: false,
              error: "Project environment was not found",
              errorType: "api_error",
            };
          }
        }

        const sourceOwner = project?.gitOwner || owner;
        const sourceRepo = project?.gitRepo || repo;
        const projectBranch = typeof project?.gitBranch === "string" ? project.gitBranch : "";
        const requestedBranch = (projectBranch || context?.branch || "").trim() || undefined;

        const response = await deployApi.prepare({
          owner: sourceOwner,
          repo: sourceRepo,
          branch: requestedBranch,
          force,
          ...scanComposePath(context?.composePath, project),
          ...(context?.env ? { env: context.env } : {}),
        });

        if (response?.error) {
          return { success: false, error: response.error, errorType: "api_error" };
        }

        if (response?.current_status === "running" || response?.exists) {
          return { success: false, buildInProgress: true };
        }

        const repoName = response.repository.name || sourceRepo;
        const selectedBranch =
          requestedBranch ||
          response.repository.selected_branch ||
          response.repository.default_branch ||
          "";
        const branches = response.repository.branches?.map((b: any) => b.name) || [];
        const branchOptions =
          selectedBranch && !branches.includes(selectedBranch)
            ? [selectedBranch, ...branches]
            : branches;
        setConfig((prev) => buildPreparedConfig(prev, {
          response,
          project,
          repoName,
          owner: response.repository.owner?.login || sourceOwner,
          branch: selectedBranch,
          branches: branchOptions,
          projectId: context?.projectId,
        }));

        return { success: true };
      } catch (err) {
        const errorMessage = getApiErrorMessage(err, "Failed to fetch repository data");
        return {
          success: false,
          error: errorMessage,
          errorType: err instanceof ApiError ? "api_error" : "network_error",
        };
      }
    },
    [buildPreparedConfig],
  );

  // ── Prepare from local path ────────────────────────────────────────────────

  const initializeFromLocal = useCallback(
    async (
      path: string,
      context?: { projectId?: string; composePath?: string; env?: Record<string, string> },
    ): Promise<{ success: boolean; error?: string; errorType?: string }> => {
      try {
        let project: PersistedProject = null;

        if (context?.projectId) {
          const projectResponse = await projectsApi.getInfo(context.projectId);
          project = projectResponse?.data?.project ?? projectResponse?.project ?? null;
        }

        const response = await deployApi.prepare({
          source: "local",
          path,
          ...scanComposePath(context?.composePath, project),
          ...(context?.env ? { env: context.env } : {}),
        });

        if (response?.error) {
          return { success: false, error: response.error, errorType: "api_error" };
        }

        const name = response.repository.name || path.split("/").pop() || "project";
        setConfig((prev) => buildPreparedConfig(prev, {
          response,
          project,
          repoName: name,
          owner: "local",
          branch: project?.gitBranch || response.repository.default_branch || "main",
          branches: [],
          projectId: context?.projectId,
          localPath: path,
        }));

        return { success: true };
      } catch (err) {
        const errorMessage = getApiErrorMessage(err, "Failed to scan local project");
        return {
          success: false,
          error: errorMessage,
          errorType: err instanceof ApiError ? "api_error" : "network_error",
        };
      }
    },
    [buildPreparedConfig],
  );

  // ── Re-scan pinned to an explicit compose path ─────────────────────────────
  // The one config field that cannot be applied locally: projectType, the service
  // list, and each service's env all come from the compose file, so pointing at a
  // different file means re-reading the source. Routes back through the same
  // initialize* path the wizard entered by, so the resulting config is identical
  // to a fresh scan of that path — no partially-updated middle state.
  const rescanWithComposePath = useCallback(
    async (composePath: string): Promise<{ success: boolean; error?: string; errorType?: string }> => {
      // "" clears the pin: the initialize* paths drop a blank value, so the scan
      // falls back to ordinary root detection.
      const trimmed = composePath.trim();
      // Carry the env the user has already entered so a compose file with
      // required variables re-scans instead of erroring as unparseable (#383).
      const env = scanEnv(config.envVars);

      if (config.localPath) {
        return initializeFromLocal(config.localPath, {
          projectId: config.projectId,
          composePath: trimmed,
          ...env,
        });
      }
      if (!config.owner || !config.repo) {
        return {
          success: false,
          error: "This project has no git or local source to re-scan",
          errorType: "api_error",
        };
      }
      const result = await initializeFromRepo(config.owner, config.repo, undefined, {
        branch: config.branch,
        projectId: config.projectId,
        composePath: trimmed,
        ...env,
      });
      return { success: result.success, error: result.error, errorType: result.errorType };
    },
    [
      config.localPath,
      config.owner,
      config.repo,
      config.branch,
      config.projectId,
      config.envVars,
      initializeFromLocal,
      initializeFromRepo,
    ],
  );

  // ── Folder upload: seed from the uploaded source's scan ─────────────────────
  // The folder was already uploaded (to an Oblien workspace or the API staging
  // dir) before we got here. We re-run the authoritative scan for that session
  // and feed it through the SAME buildPreparedConfig core as repo/local, then
  // carry `uploadSessionId` in the config so the deploy adopts that source.
  const initializeFromUpload = useCallback(
    async (
      sessionId: string,
      context?: { projectId?: string; stack?: string; packageManager?: string; name?: string },
    ): Promise<{ success: boolean; error?: string; errorType?: string }> => {
      try {
        let project: PersistedProject = null;
        if (context?.projectId) {
          const projectResponse = await projectsApi.getInfo(context.projectId);
          project = projectResponse?.data?.project ?? projectResponse?.project ?? null;
        }

        // The upload wizard has the user pick the stack up front (like the
        // template list), so we seed the config from that stack's defaults —
        // no auto-detection. `scan` is only used as a fallback (e.g. an MCP/
        // programmatic caller that didn't pick a stack).
        let response: PrepareProjectResponse;
        let name: string;

        const stackDef: StackDefinition | undefined = context?.stack
          ? (STACKS[context.stack as StackId] as StackDefinition)
          : undefined;
        if (context?.stack && stackDef) {
          name = context.name || "app";
          const pm = context.packageManager || "npm";
          response = {
            repository: {
              name,
              full_name: name,
              owner: { login: "upload" },
              private: true,
              default_branch: "main",
            },
            stack: context.stack,
            projectType: "app",
            category: stackDef.category,
            packageManager: pm,
            installCommand: "",
            buildCommand: stackDef.defaultBuildCommand ?? "",
            startCommand: stackDef.defaultStartCommand ?? "",
            buildImage: getBuildImage(context.stack as StackId, pm),
            outputDirectory: stackDef.outputDirectory ?? "",
            rootDirectory: "",
            productionPaths: stackDef.productionPaths ? [...stackDef.productionPaths] : [],
            port: stackDef.defaultPort ?? 3000,
            services: undefined,
          } as unknown as PrepareProjectResponse;
        } else {
          const scan = await folderApi.scan(sessionId);
          if ((scan as { error?: string })?.error) {
            return { success: false, error: (scan as { error?: string }).error, errorType: "api_error" };
          }
          name = scan.name || context?.name || "app";
          // Adapt the flat scan result into the prepare-shaped response the
          // shared config builder consumes.
          response = {
            repository: {
              name,
              full_name: name,
              owner: { login: "upload" },
              private: true,
              default_branch: "main",
            },
            stack: scan.stack,
            projectType: scan.projectType,
            category: scan.category,
            packageManager: scan.packageManager,
            installCommand: scan.installCommand,
            buildCommand: scan.buildCommand,
            startCommand: scan.startCommand,
            buildImage: scan.buildImage,
            outputDirectory: scan.outputDirectory,
            rootDirectory: scan.rootDirectory,
            productionPaths: scan.productionPaths,
            port: scan.port,
            services: scan.services,
          } as unknown as PrepareProjectResponse;
        }

        setConfig((prev) => buildPreparedConfig(prev, {
          response,
          project,
          repoName: name,
          owner: "upload",
          branch: "main",
          branches: [],
          projectId: context?.projectId,
          uploadSessionId: sessionId,
        }));

        return { success: true };
      } catch (err) {
        const errorMessage = getApiErrorMessage(err, "Failed to load the uploaded folder");
        return {
          success: false,
          error: errorMessage,
          errorType: err instanceof ApiError ? "api_error" : "network_error",
        };
      }
    },
    [buildPreparedConfig],
  );

  // ── Config edit: hydrate from the SAVED project, no repo re-detection ───────
  // Used for the wizard's "Edit" (mode=config). Reconstructs a prepare-shaped
  // response from the persisted project + service rows (buildSavedProjectResponse)
  // and runs it through the SAME buildPreparedConfig core the repo/local detection
  // paths use — so single-app, services, and monorepo edits share one code path.
  // Nothing re-clones the repo, the wizard opens instantly, and a DB-defined
  // compose stack can never collapse to a single app just because the repo has
  // no committed compose file (the services come from the DB, not detection).
  const initializeFromProject = useCallback(
    async (
      projectId: string,
      context?: { branch?: string },
    ): Promise<{ success: boolean; error?: string; errorType?: string }> => {
      try {
        const res = await projectsApi.getInfo(projectId);
        const project: PersistedProject = res?.data?.project ?? res?.project ?? null;
        if (!project) {
          return { success: false, error: "Project was not found", errorType: "api_error" };
        }

        // Always pull the saved service rows — they're the source of truth for
        // whether this is a services/monorepo project (buildSavedProjectResponse
        // derives the shape from them). Fetching for a plain app is a cheap empty
        // list and removes any dependency on the getInfo-derived projectType.
        const svcRes = await servicesApi.list(projectId).catch(() => null);
        const serviceRows: Service[] = svcRes?.services ?? [];

        // Production env → config.envVars (secret VALUES come back masked; blank
        // them — the env editor owns secret edits — rather than seeding the mask).
        const envRes = await projectsApi.getEnv(projectId).catch(() => null);
        const envVars: DeploymentConfig["envVars"] = (envRes?.data ?? [])
          .filter((v) => v.environment === "production")
          .map((v) => ({ key: v.key, value: v.isSecret ? "" : v.value, visible: true }));

        const response = buildSavedProjectResponse(project, serviceRows);
        const repoName = project.gitRepo || project.name || "project";
        const branch =
          typeof project.gitBranch === "string" ? project.gitBranch : (context?.branch ?? "");

        setConfig((prev) => {
          // Guard: don't let an EMPTY service-row fetch collapse an already-loaded
          // multi-service config to single-app. The DeploymentProvider is shared
          // across /build/[id] and /deploy/[slug] (one layout), so arriving here
          // from a compose deploy's build page means `prev` already holds that
          // deployment's services — the freshest, most complete source. Keep it
          // when the DB returned nothing (rows can lag a just-started deploy).
          const prevHoldsThisMultiProject =
            prev.projectId === projectId &&
            (prev.projectType === "services" || prev.projectType === "monorepo") &&
            ((prev.services?.length ?? 0) > 0 || (prev.monorepoApps?.length ?? 0) > 0);
          if (serviceRows.length === 0 && prevHoldsThisMultiProject) {
            return { ...prev, projectId, envVars: envVars.length ? envVars : prev.envVars };
          }

          return {
            ...buildPreparedConfig(prev, {
              response,
              project,
              repoName,
              // Non-empty owner keeps the page's `!config.owner` guard satisfied;
              // local-sourced projects use the "local" sentinel (matches initializeFromLocal).
              owner: project.gitOwner || (project.localPath ? "local" : repoName),
              branch,
              branches: branch ? [branch] : [],
              projectId,
              localPath: project.localPath || undefined,
            }),
            // buildPreparedConfig (shared with detection) doesn't load production
            // env — overlay the saved values we fetched above.
            envVars,
            // Repo-less catalog app: deploys from its saved service rows with no
            // git source (the deploy guards treat this like local/upload).
            isApp: Boolean((project as { isApp?: boolean }).isApp),
            appTemplateId: (project as { appTemplateId?: string }).appTemplateId,
          };
        });

        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: getApiErrorMessage(err, "Failed to load project settings"),
          errorType: err instanceof ApiError ? "api_error" : "network_error",
        };
      }
    },
    [buildPreparedConfig],
  );

  return {
    config,
    setConfig,
    updateConfig,
    updateOptions,
    initializeFromRepo,
    initializeFromLocal,
    initializeFromUpload,
    initializeFromProject,
    rescanWithComposePath,
  };
}
