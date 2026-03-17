"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { FrameworkId } from "@/components/import-project/types";
import { deployApi } from "@/lib/api";
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

  // ── Prepare from GitHub repo ───────────────────────────────────────────────

  const initializeFromRepo = useCallback(
    async (
      owner: string,
      repo: string,
      force?: string,
    ): Promise<{ success: boolean; error?: string; errorType?: string; buildInProgress?: boolean }> => {
      try {
        const response = await deployApi.prepare({ owner, repo, force });

        if (response?.error) {
          return { success: false, error: response.error, errorType: "api_error" };
        }

        if (response?.current_status === "running" || response?.exists) {
          return { success: false, buildInProgress: true };
        }

        const repoName = response.repository.name || repo;
        const detectedStack = (response.stack || "nextjs") as FrameworkId;
        const stackDef = STACKS[detectedStack as keyof typeof STACKS] as StackDefinition | undefined;
        const hasServer = !!response.startCommand;
        const hasBuild = !!response.buildCommand;

        setConfig((prev) => ({
          ...prev,
          repo: repoName,
          owner: response.repository.owner?.login || owner,
          projectName: repoName,
          projectType: response.projectType || "app",
          domain: repoName.toLowerCase(),
          framework: detectedStack,
          detectedFramework: detectedStack,
          buildStrategy: resolveInitialStrategy(stackDef),
          packageManager: response.packageManager || "npm",
          buildImage: response.buildImage || "node:22",
          branch: response.repository.default_branch || "main",
          branches: response.repository.branches?.map((b: any) => b.name) || [],
          services: response.services || [],
          options: {
            buildCommand: response.buildCommand || "",
            installCommand: response.installCommand || "",
            outputDirectory: response.outputDirectory || "",
            productionPaths: Array.isArray(response.productionPaths)
              ? response.productionPaths.join(", ")
              : response.productionPaths || "",
            startCommand: response.startCommand || "",
            productionPort: String(response.port || 3000),
            rootDirectory: "./",
            hasServer,
            hasBuild,
          },
        }));

        return { success: true };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Failed to fetch repository data";
        return { success: false, error: errorMessage, errorType: "network_error" };
      }
    },
    [],
  );

  // ── Prepare from local path ────────────────────────────────────────────────

  const initializeFromLocal = useCallback(
    async (path: string): Promise<{ success: boolean; error?: string; errorType?: string }> => {
      try {
        const response = await deployApi.prepare({ source: "local", path });

        if (response?.error) {
          return { success: false, error: response.error, errorType: "api_error" };
        }

        const name = response.repository.name || path.split("/").pop() || "project";
        const detectedStack = (response.stack || "nextjs") as FrameworkId;
        const stackDef = STACKS[detectedStack as keyof typeof STACKS] as StackDefinition | undefined;
        const hasServer = !!response.startCommand;
        const hasBuild = !!response.buildCommand;

        setConfig((prev) => ({
          ...prev,
          repo: name,
          owner: "local",
          projectName: name,
          projectType: response.projectType || "app",
          domain: name.toLowerCase().replace(/[^a-z0-9-]/g, ""),
          framework: detectedStack,
          detectedFramework: detectedStack,
          buildStrategy: resolveInitialStrategy(stackDef),
          packageManager: response.packageManager || "npm",
          buildImage: response.buildImage || "node:22",
          branch: "main",
          branches: [],
          services: response.services || [],
          options: {
            buildCommand: response.buildCommand || "",
            installCommand: response.installCommand || "",
            outputDirectory: response.outputDirectory || "",
            productionPaths: Array.isArray(response.productionPaths)
              ? response.productionPaths.join(", ")
              : response.productionPaths || "",
            startCommand: response.startCommand || "",
            productionPort: String(response.port || 3000),
            rootDirectory: path,
            hasServer,
            hasBuild,
          },
        }));

        return { success: true };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Failed to scan local project";
        return { success: false, error: errorMessage, errorType: "network_error" };
      }
    },
    [],
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
