"use client";

/**
 * Slice provider for monorepo sub-apps.
 *
 * Wraps a child tree with a sliced `DeploymentContext` where the visible
 * `config` (and `updateConfig` / `updateOptions`) target one specific entry
 * in `parent.config.monorepoApps`. The shared form components
 * (`ProjectSettings`, `BuildSettings`, `EnvironmentVariables`) read/write
 * through `useDeployment()` and need no modification - they just see the
 * sub-app slice as if it were a normal single-app config.
 *
 * Project-level fields (repo, owner, branch, projectName, branches,
 * buildStrategy, deployTarget, serverId, runtimeMode) pass through to the
 * parent unchanged. Writes that touch a sub-app field land on
 * `monorepoApps[index]`. Writes that touch shared workspace settings land on
 * `monorepoWorkspace`.
 */

import React, { useContext, useMemo } from "react";
import { DeploymentContext } from "../DeploymentContext";
import type { DeploymentConfig, DeploymentContextType, DeploymentOptions, MonorepoAppConfig } from "./types";

/**
 * Convert a sub-app slice into a `DeploymentConfig`-shaped view. The result
 * is consumed by single-app form components as if it were the top-level
 * config.
 */
function sliceToConfigView(parent: DeploymentConfig, app: MonorepoAppConfig): DeploymentConfig {
  return {
    ...parent,
    framework: app.framework,
    detectedFramework: app.detectedFramework,
    packageManager: app.packageManager,
    buildImage: app.buildImage,
    runtimeVersion: undefined,
    runtimeImage: undefined,
    envVars: app.envVars,
    publicEndpoints: app.publicEndpoints,
    noPublicRoute: app.exposed === false,
    options: {
      buildCommand: app.buildCommand,
      installCommand: app.installCommand,
      startCommand: app.startCommand,
      outputDirectory: app.outputDirectory,
      productionPaths: app.productionPaths.join(", "),
      productionPort: app.port,
      rootDirectory: app.rootDirectory,
      hasServer: app.hasServer,
      hasBuild: app.hasBuild,
    },
  };
}

/** Fields on `DeploymentConfig` that, when patched, target the sub-app slice. */
const SLICE_FIELDS = [
  "framework",
  "detectedFramework",
  "packageManager",
  "buildImage",
  "envVars",
  "publicEndpoints",
  "options",
  "noPublicRoute",
] as const satisfies readonly (keyof DeploymentConfig)[];

/** Fields on `DeploymentOptions` that map back to the sub-app slice. */
const SLICE_OPTION_FIELDS = [
  "buildCommand",
  "installCommand",
  "startCommand",
  "outputDirectory",
  "productionPort",
  "rootDirectory",
  "hasServer",
  "hasBuild",
] as const satisfies readonly (keyof DeploymentOptions)[];

function patchSubApp(
  app: MonorepoAppConfig,
  updates: Partial<DeploymentConfig>,
): MonorepoAppConfig {
  const next: MonorepoAppConfig = updates.options
    ? patchSubAppOptions(app, updates.options)
    : { ...app };
  if (updates.noPublicRoute !== undefined) next.exposed = !updates.noPublicRoute;
  if (updates.framework !== undefined) next.framework = updates.framework;
  if (updates.detectedFramework !== undefined) next.detectedFramework = updates.detectedFramework;
  if (updates.packageManager !== undefined) next.packageManager = updates.packageManager;
  if (updates.buildImage !== undefined) next.buildImage = updates.buildImage;
  if (updates.envVars !== undefined) next.envVars = updates.envVars;
  if (updates.publicEndpoints !== undefined) next.publicEndpoints = updates.publicEndpoints;
  return next;
}

function patchSubAppOptions(
  app: MonorepoAppConfig,
  options: Partial<DeploymentOptions>,
): MonorepoAppConfig {
  const next: MonorepoAppConfig = { ...app };
  if (options.buildCommand !== undefined) next.buildCommand = options.buildCommand;
  if (options.installCommand !== undefined) next.installCommand = options.installCommand;
  if (options.startCommand !== undefined) next.startCommand = options.startCommand;
  if (options.outputDirectory !== undefined) next.outputDirectory = options.outputDirectory;
  if (options.productionPort !== undefined) next.port = options.productionPort;
  if (options.rootDirectory !== undefined) next.rootDirectory = options.rootDirectory;
  if (options.hasServer !== undefined) next.hasServer = options.hasServer;
  if (options.hasBuild !== undefined) next.hasBuild = options.hasBuild;
  if (options.productionPaths !== undefined) {
    next.productionPaths = options.productionPaths
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  }
  return next;
}

/** Whether ANY key in the update touches a sub-app field. */
function updateTouchesSlice(updates: Partial<DeploymentConfig>): boolean {
  return SLICE_FIELDS.some((key) => key in updates);
}

/** Whether ANY key in the options update touches a sub-app field. */
function optionsTouchSlice(options: Partial<DeploymentOptions>): boolean {
  return SLICE_OPTION_FIELDS.some((key) => key in options) || "productionPaths" in options;
}

/**
 * Rewrite a `monorepoApps` array by patching one entry.
 */
function withReplacedApp(
  apps: MonorepoAppConfig[],
  index: number,
  next: MonorepoAppConfig,
): MonorepoAppConfig[] {
  const copy = apps.slice();
  copy[index] = next;
  return copy;
}

export const MonorepoAppProvider: React.FC<{
  index: number;
  children: React.ReactNode;
}> = ({ index, children }) => {
  const parent = useContext(DeploymentContext);
  if (!parent) {
    throw new Error("MonorepoAppProvider must be used within DeploymentProvider");
  }

  const apps = parent.config.monorepoApps ?? [];
  const app = apps[index];

  const sliceValue = useMemo<DeploymentContextType | null>(() => {
    if (!app) return null;

    const slicedConfig = sliceToConfigView(parent.config, app);

    const updateConfig: DeploymentContextType["updateConfig"] = (updates) => {
      // Updates that touch the sub-app slice get patched into monorepoApps[index].
      // Updates that touch project-level fields pass through to the parent.
      const sliceUpdates: Partial<DeploymentConfig> = {};
      const passthrough: Partial<DeploymentConfig> = {};

      for (const key of Object.keys(updates) as (keyof DeploymentConfig)[]) {
        if ((SLICE_FIELDS as readonly string[]).includes(key as string)) {
          (sliceUpdates as Record<string, unknown>)[key] = (updates as Record<string, unknown>)[key];
        } else {
          (passthrough as Record<string, unknown>)[key] = (updates as Record<string, unknown>)[key];
        }
      }

      // Apply project-level updates first, then sub-app slice patch - both go
      // through the parent's updateConfig so React batches them in one render.
      if (Object.keys(sliceUpdates).length > 0 && updateTouchesSlice(sliceUpdates)) {
        const nextApp = patchSubApp(app, sliceUpdates);
        passthrough.monorepoApps = withReplacedApp(apps, index, nextApp);
      }
      if (Object.keys(passthrough).length > 0) {
        parent.updateConfig(passthrough);
      }
    };

    const updateOptions: DeploymentContextType["updateOptions"] = (options) => {
      if (!optionsTouchSlice(options)) return;
      const nextApp = patchSubAppOptions(app, options);
      parent.updateConfig({ monorepoApps: withReplacedApp(apps, index, nextApp) });
    };

    return {
      ...parent,
      config: slicedConfig,
      updateConfig,
      updateOptions,
    };
  }, [parent, app, apps, index]);

  if (!sliceValue) return null;

  return (
    <DeploymentContext.Provider value={sliceValue}>
      {children}
    </DeploymentContext.Provider>
  );
};
