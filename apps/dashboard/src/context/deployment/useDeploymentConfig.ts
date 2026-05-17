"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { FrameworkId } from "@/components/import-project/types";
import { deployApi, projectsApi } from "@/lib/api";
import type { PrepareProjectResponse } from "@/lib/api/deploy";
import { ApiError, getApiErrorMessage } from "@/lib/api/client";
import { settingsApi } from "@/lib/api/settings";
import type { BuildMode } from "@/lib/api/settings";
import { STACKS, type StackDefinition } from "@repo/core";
import type { BuildStrategy, DeploymentConfig, DeploymentModeSnapshot } from "./types";
import {
  DEFAULT_CONFIG,
  createPublicEndpoint,
  ensurePublicEndpoints,
  syncPublicEndpointState,
} from "./types";
import {
  buildSingleModeSnapshotFromCompose,
  syncActiveModeSnapshot,
} from "./mode-config";
import { normalizeSubdomain } from "@/utils/subdomain";

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
    visible: false,
  }));
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

function mapStoredPublicEndpoints(project: PersistedProject) {
  return project?.publicEndpoints?.map((endpoint: {
    port?: number;
    targetPath?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
  }) => createPublicEndpoint({
    port: endpoint.port ? String(endpoint.port) : "",
    targetPath: endpoint.targetPath || "",
    domain: endpoint.domain || "",
    customDomain: endpoint.customDomain || "",
    domainType: endpoint.domainType || "free",
  }));
}

function buildPreparedOptions(response: PrepareProjectResponse): DeploymentConfig["options"] {
  const hasServer = !!response.startCommand;
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

function resolvePreparedProjectContext(
  response: PrepareProjectResponse,
): PreparedProjectContext {
  const projectType = response.projectType || "app";
  const serviceDeploymentMode = projectType === "services" ? "services" : "single";
  const detectedStack = (response.stack || "nextjs") as FrameworkId;
  const stackDef = STACKS[detectedStack as keyof typeof STACKS] as StackDefinition | undefined;
  const singleAppCandidate = response.singleAppCandidate;
  const singleStackDef = singleAppCandidate
    ? (STACKS[singleAppCandidate.stack as keyof typeof STACKS] as StackDefinition | undefined)
    : undefined;
  const composeDefaults = projectType === "services"
    ? buildComposeDefaults(response, detectedStack)
    : undefined;

  return {
    projectType,
    serviceDeploymentMode,
    detectedStack,
    stackDef,
    singleAppCandidate,
    singleStackDef,
    composeDefaults,
    preparedOptions: composeDefaults?.options ?? buildPreparedOptions(response),
  };
}

function resolvePreparedRoutingState(
  response: PrepareProjectResponse,
  project: PersistedProject,
  repoName: string,
  context: Pick<PreparedProjectContext, "projectType" | "preparedOptions">,
): PreparedRoutingState {
  const effectiveHasServer = context.projectType === "services"
    ? context.preparedOptions.hasServer
    : project?.hasServer ?? context.preparedOptions.hasServer;
  const primaryDomain = project?.slug || normalizeSubdomain(repoName);
  const primaryPort = context.projectType === "services"
    ? context.preparedOptions.productionPort
    : String(project?.port ?? response.port ?? "");
  const hasStoredPort = context.projectType === "services" ? false : hasSavedProjectPort(project);

  return {
    effectiveHasServer,
    primaryPort,
    hasStoredPort,
    publicEndpoints: ensurePublicEndpoints(
      mapStoredPublicEndpoints(project),
      effectiveHasServer
        ? {
            port: primaryPort,
            domain: primaryDomain,
            domainType: "free",
          }
        : {
            targetPath: "/",
            domain: primaryDomain,
            domainType: "free",
          },
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
 * and used as the initial default for buildStrategy — but the per-deploy
 * value in config is the sole source of truth sent to the API.
 */
export function useDeploymentConfig() {
  const [config, setConfig] = useState<DeploymentConfig>(DEFAULT_CONFIG);
  const userBuildPref = useRef<BuildMode>("auto");

  const normalizeConfig = useCallback((next: DeploymentConfig): DeploymentConfig => {
    return syncActiveModeSnapshot(syncPublicEndpointState(next));
  }, []);

  const normalizePreparedConfig = useCallback(
    (
      next: DeploymentConfig,
      singleModeDefaults?: Pick<DeploymentModeSnapshot, "buildStrategy" | "runtimeMode">,
    ): DeploymentConfig => {
      const normalized = normalizeConfig(next);

      if (normalized.projectType !== "services") {
        return normalized;
      }

      const singleSnapshot = buildSingleModeSnapshotFromCompose(normalized, singleModeDefaults);
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
    }).catch(() => { /* non-critical — fall back to stack default */ });
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

  /** Resolve initial buildStrategy: user global pref > stack default > "server" */
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
      } = args;
      const preparedContext = resolvePreparedProjectContext(response);
      const routingState = resolvePreparedRoutingState(response, project, repoName, preparedContext);
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
        projectName: project?.name || repoName,
        projectType: preparedContext.projectType,
        serviceDeploymentMode: preparedContext.serviceDeploymentMode,
        composeDefaults: preparedContext.composeDefaults,
        singleAppCandidate: preparedContext.singleAppCandidate,
        modeSnapshots: undefined,
        framework: preparedContext.detectedStack,
        detectedFramework: preparedContext.detectedStack,
        buildStrategy: normalizeBuildStrategy(preparedContext.projectType, preparedContext.stackDef),
        runtimeMode: normalizeRuntimeMode(preparedContext.projectType),
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
      context?: { branch?: string; projectId?: string },
    ): Promise<{ success: boolean; error?: string; errorType?: string; buildInProgress?: boolean }> => {
      try {
        let project: Record<string, any> | null = null;

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
      context?: { projectId?: string },
    ): Promise<{ success: boolean; error?: string; errorType?: string }> => {
      try {
        let project: Record<string, any> | null = null;

        if (context?.projectId) {
          const projectResponse = await projectsApi.getInfo(context.projectId);
          project = projectResponse?.data?.project ?? projectResponse?.project ?? null;
        }

        const response = await deployApi.prepare({ source: "local", path });

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

  return {
    config,
    setConfig,
    updateConfig,
    updateOptions,
    initializeFromRepo,
    initializeFromLocal,
  };
}
