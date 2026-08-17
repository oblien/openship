import {
  applyReleasePreset,
  isReleasePresetId,
  prefixesFromPreset,
  RELEASE_PRESETS,
  type ReleasePresetId,
} from "@repo/core";
import type { MountedReleaseConfig } from "./mounted-release.config";
import type { ServicePathPrefix } from "./release-planner";

export {
  applyReleasePreset,
  isReleasePresetId,
  prefixesFromPreset,
  RELEASE_PRESETS,
  type ReleasePresetId,
};

/** Preset fill as a persistable mounted-release recipe. */
export function mountedReleaseFromPreset(
  id: ReleasePresetId,
  extra?: Partial<MountedReleaseConfig>,
): MountedReleaseConfig {
  const filled = applyReleasePreset(id);
  return {
    ...filled,
    ...extra,
    enabled: extra?.enabled ?? true,
    preset: id,
    buildMode: extra?.buildMode ?? filled.buildMode,
    runtimeInstall: extra?.runtimeInstall ?? filled.runtimeInstall,
    containerPath: extra?.containerPath ?? filled.containerPath,
    sharedPaths: extra?.sharedPaths ?? filled.sharedPaths,
    prepareCommand: extra?.prepareCommand ?? filled.prepareCommand,
    reloadCommand: extra?.reloadCommand ?? filled.reloadCommand,
    healthPath: extra?.healthPath ?? filled.healthPath,
    builderCachePaths: extra?.builderCachePaths ?? filled.builderCachePaths,
  };
}

export function plannerPrefixesForConfig(
  config: { preset?: string | null } | null | undefined,
): ServicePathPrefix[] | undefined {
  return prefixesFromPreset(config?.preset);
}
