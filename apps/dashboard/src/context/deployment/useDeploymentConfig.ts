"use client";

import { useState, useCallback } from "react";
import type { FrameworkId } from "@/components/import-project/types";
import { deployApi } from "@/lib/api";
import { STACKS, type StackDefinition } from "@repo/core";
import type { DeploymentConfig } from "./types";
import { DEFAULT_CONFIG } from "./types";

/**
 * Owns the deployment configuration state and prepare logic.
 *
 * Prepare = resolve project info from a source (GitHub repo or local path),
 * detect stack, and populate config with defaults.
 */
export function useDeploymentConfig() {
  const [config, setConfig] = useState<DeploymentConfig>(DEFAULT_CONFIG);

  const updateConfig = useCallback((updates: Partial<DeploymentConfig>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
  }, []);

  const updateOptions = useCallback((updates: Partial<DeploymentConfig["options"]>) => {
    setConfig((prev) => ({ ...prev, options: { ...prev.options, ...updates } }));
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
          buildStrategy: stackDef?.defaultBuildStrategy ?? "server",
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
          buildStrategy: stackDef?.defaultBuildStrategy ?? "server",
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
