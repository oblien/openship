/**
 * Runtime layer barrel exports.
 *
 * Use `createRuntime()` for lazy-loaded runtime resolution (preferred).
 * Import classes directly only when you know the mode at import time.
 */

// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  RuntimeAdapter,
  RuntimeCapability,
  MultiServiceRuntimeAdapter,
  MultiServiceGroupHandle,
  MultiServiceDeployConfig,
  MultiServiceDeployResult,
  DockerMount,
  DockerPortBinding,
  DockerContainerSummary,
  DockerContainerDetail,
  DockerVolumeInfo,
  DockerNetworkInfo,
} from "./types";
export { assertCapability, isMultiServiceRuntime } from "./types";
export { runBuildPipeline, BuildLogger, parseLogLevel, type BuildEnvironment } from "./build-pipeline";

// ─── Runtime classes ─────────────────────────────────────────────────────────
export { DockerRuntime, type DockerConnectionOptions } from "./docker";
export { BareRuntime, type BareRuntimeOptions } from "./bare";

// ─── Supervisor ──────────────────────────────────────────────────────────────
export type { ProcessSupervisor, SupervisorDeployOpts } from "./supervisor/types";
export { NohupSupervisor } from "./supervisor/nohup";
export { SystemdSupervisor } from "./supervisor/systemd";
export { detectSupervisor } from "./supervisor/detect";

// ─── Factory ─────────────────────────────────────────────────────────────────

import type { RuntimeAdapter } from "./types";
import type { DockerConnectionOptions } from "./docker";
import type { BareRuntimeOptions } from "./bare";
import type { SystemManager } from "../system/setup";

export type RuntimeMode = "docker" | "bare";

export interface CreateRuntimeOptions {
  mode: RuntimeMode;
  /** Docker connection config (only used when mode="docker") */
  docker?: DockerConnectionOptions;
  /** Optional shared system manager for prerequisite checks */
  systemManager?: SystemManager | null;
  /** Bare runtime config (only used when mode="bare") */
  bare?: BareRuntimeOptions;
}

/**
 * Create a runtime adapter - async with lazy imports.
 *
 * ZERO BLEED GUARANTEE:
 *   Docker-related code (dockerode, ssh2) is only imported when mode="docker".
 *   "cloud" and "bare" modes never load those dependencies.
 */
export async function createRuntime(opts: CreateRuntimeOptions): Promise<RuntimeAdapter> {
  switch (opts.mode) {
    case "docker": {
      const { DockerRuntime } = await import("./docker");
      return await DockerRuntime.create(opts.docker, opts.systemManager);
    }
    case "bare": {
      const { BareRuntime } = await import("./bare");
      return new BareRuntime(opts.bare);
    }
  }
}
