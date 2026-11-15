import type { BuildKind, WorkloadType } from "./deployment-class";

export type BuildCommandField = "installCommand" | "startCommand";

/** Commands consumed by a generated app build, shared by settings and preflight. */
export function missingBuildCommands(config: {
  build: BuildKind;
  workload: WorkloadType;
  hasBuild?: boolean | null;
  installCommand?: string | null;
  startCommand?: string | null;
}): BuildCommandField[] {
  if (config.build === "dockerfile" || config.build === "prebuilt") return [];
  const missing: BuildCommandField[] = [];
  if (config.hasBuild && !config.installCommand?.trim()) missing.push("installCommand");
  if (config.workload !== "static" && !config.startCommand?.trim()) missing.push("startCommand");
  return missing;
}
