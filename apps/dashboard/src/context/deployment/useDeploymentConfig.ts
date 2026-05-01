"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { FrameworkId } from "@/components/import-project/types";
import { deployApi, projectsApi } from "@/lib/api";
import { ApiError, getApiErrorMessage } from "@/lib/api/client";
import { settingsApi } from "@/lib/api/settings";
import type { BuildMode } from "@/lib/api/settings";
import { STACKS, type StackDefinition } from "@repo/core";
import type { BuildStrategy, DeploymentConfig } from "./types";
import { DEFAULT_CONFIG } from "./types";

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

  // Fetch user's global build mode preference once
  useEffect(() => {
    settingsApi.get().then((res) => {
      if (res?.buildMode) userBuildPref.current = res.buildMode;
    }).catch(() => { /* non-critical — fall back to stack default */ });
  }, []);

  const updateConfig = useCallback((updates: Partial<DeploymentConfig>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
  }, []);

  const updateOptions = useCallback((updates: Partial<DeploymentConfig["options"]>) => {
    setConfig((prev) => ({ ...prev, options: { ...prev.options, ...updates } }));
  }, []);

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
        const projectType = response.projectType || "app";
        const detectedStack = (response.stack || "nextjs") as FrameworkId;
        const stackDef = STACKS[detectedStack as keyof typeof STACKS] as StackDefinition | undefined;
        const hasServer = !!response.startCommand;
        const hasBuild = !!response.buildCommand;

        setConfig((prev) => ({
          ...prev,
          projectId: context?.projectId,
          repo: repoName,
          owner: response.repository.owner?.login || sourceOwner,
          projectName: project?.name || repoName,
          projectType,
          domain: project?.slug || repoName.toLowerCase(),
          framework: detectedStack,
          detectedFramework: detectedStack,
          buildStrategy: normalizeBuildStrategy(projectType, stackDef),
          runtimeMode: normalizeRuntimeMode(projectType),
          packageManager: project?.packageManager || response.packageManager || "npm",
          buildImage: project?.buildImage || response.buildImage || "node:22",
          branch: selectedBranch,
          branches: branchOptions,
          services: response.services || [],
          options: {
            buildCommand: project?.buildCommand ?? response.buildCommand ?? "",
            installCommand: project?.installCommand ?? response.installCommand ?? "",
            outputDirectory: project?.outputDirectory ?? response.outputDirectory ?? "",
            productionPaths: project?.productionPaths ?? (Array.isArray(response.productionPaths)
              ? response.productionPaths.join(", ")
              : response.productionPaths || ""),
            startCommand: project?.startCommand ?? response.startCommand ?? "",
            productionPort: String(project?.port ?? response.port ?? 3000),
            rootDirectory: project?.rootDirectory || "./",
            hasServer: project?.hasServer ?? hasServer,
            hasBuild: project?.hasBuild ?? hasBuild,
          },
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
    [normalizeBuildStrategy, normalizeRuntimeMode],
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
        const projectType = response.projectType || "app";
        const detectedStack = (response.stack || "nextjs") as FrameworkId;
        const stackDef = STACKS[detectedStack as keyof typeof STACKS] as StackDefinition | undefined;
        const hasServer = !!response.startCommand;
        const hasBuild = !!response.buildCommand;

        setConfig((prev) => ({
          ...prev,
          projectId: context?.projectId,
          repo: name,
          owner: "local",
          localPath: path,
          projectName: project?.name || name,
          projectType,
          domain: project?.slug || name.toLowerCase().replace(/[^a-z0-9-]/g, ""),
          framework: detectedStack,
          detectedFramework: detectedStack,
          buildStrategy: normalizeBuildStrategy(projectType, stackDef),
          runtimeMode: normalizeRuntimeMode(projectType),
          packageManager: project?.packageManager || response.packageManager || "npm",
          buildImage: project?.buildImage || response.buildImage || "node:22",
          branch: project?.gitBranch || response.repository.default_branch || "main",
          branches: [],
          services: response.services || [],
          options: {
            buildCommand: project?.buildCommand ?? response.buildCommand ?? "",
            installCommand: project?.installCommand ?? response.installCommand ?? "",
            outputDirectory: project?.outputDirectory ?? response.outputDirectory ?? "",
            productionPaths: project?.productionPaths ?? (Array.isArray(response.productionPaths)
              ? response.productionPaths.join(", ")
              : response.productionPaths || ""),
            startCommand: project?.startCommand ?? response.startCommand ?? "",
            productionPort: String(project?.port ?? response.port ?? 3000),
            rootDirectory: project?.rootDirectory || path,
            hasServer: project?.hasServer ?? hasServer,
            hasBuild: project?.hasBuild ?? hasBuild,
          },
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
    [normalizeBuildStrategy, normalizeRuntimeMode],
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
