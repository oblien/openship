/**
 * Runtime layer barrel exports.
 *
 * Use `createRuntime()` for lazy-loaded runtime resolution (preferred).
 * Import classes directly only when you know the mode at import time.
 */

// ─── Types ───────────────────────────────────────────────────────────────────
export type { RuntimeAdapter, RuntimeCapability } from "./types";
export { assertCapability } from "./types";
export { runBuildPipeline, BuildLogger, type BuildEnvironment } from "./build-pipeline";

// ─── Runtime classes ─────────────────────────────────────────────────────────
export { DockerRuntime, type DockerConnectionOptions } from "./docker";
export { BareRuntime, type BareRuntimeOptions } from "./bare";
export { CloudRuntime } from "./cloud";

// ─── Factory ─────────────────────────────────────────────────────────────────

import type { RuntimeAdapter } from "./types";
import type { DockerConnectionOptions } from "./docker";
import type { BareRuntimeOptions } from "./bare";

export type RuntimeMode = "docker" | "bare" | "cloud";

export interface CreateRuntimeOptions {
  mode: RuntimeMode;
  /** Docker connection config (only used when mode="docker") */
  docker?: DockerConnectionOptions;
  /** Bare runtime config (only used when mode="bare") */
  bare?: BareRuntimeOptions;
  /** Oblien client ID (only used when mode="cloud") */
  cloudClientId?: string;
  /** Oblien client secret (only used when mode="cloud") */
  cloudClientSecret?: string;
}

/**
 * Create a runtime adapter — async with lazy imports.
 *
 * ZERO BLEED GUARANTEE:
 *   Docker-related code (dockerode, ssh2) is only imported when mode="docker".
 *   "cloud" and "bare" modes never load those dependencies.
 */
export async function createRuntime(opts: CreateRuntimeOptions): Promise<RuntimeAdapter> {
  switch (opts.mode) {
    case "docker": {
      const { DockerRuntime } = await import("./docker");
      return new DockerRuntime(opts.docker);
    }
    case "bare": {
      const { BareRuntime } = await import("./bare");
      return new BareRuntime(opts.bare);
    }
    case "cloud": {
      const { CloudRuntime } = await import("./cloud");
      return new CloudRuntime(
        opts.cloudClientId ?? process.env.OBLIEN_CLIENT_ID ?? "",
        opts.cloudClientSecret ?? process.env.OBLIEN_CLIENT_SECRET ?? "",
      );
    }
  }
}
