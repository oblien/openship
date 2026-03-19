/**
 * Runtime layer barrel exports.
 *
 * Use `createRuntime()` for lazy-loaded runtime resolution (preferred).
 * Import classes directly only when you know the mode at import time.
 */

// ─── Types ───────────────────────────────────────────────────────────────────
export type { RuntimeAdapter, RuntimeCapability } from "./types";
export { assertCapability } from "./types";
export { runBuildPipeline, BuildLogger, parseLogLevel, type BuildEnvironment } from "./build-pipeline";

// ─── Runtime classes ─────────────────────────────────────────────────────────
export { DockerRuntime, type DockerConnectionOptions } from "./docker";
export { BareRuntime, type BareRuntimeOptions } from "./bare";
export { CloudRuntime } from "./cloud";

// ─── Supervisor ──────────────────────────────────────────────────────────────
export type { ProcessSupervisor, SupervisorDeployOpts } from "./supervisor/types";
export { NohupSupervisor } from "./supervisor/nohup";
export { SystemdSupervisor } from "./supervisor/systemd";
export { detectSupervisor } from "./supervisor/detect";

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
  /** Oblien client ID (cloud — master creds) */
  cloudClientId?: string;
  /** Oblien client secret (cloud — master creds) */
  cloudClientSecret?: string;
  /** Oblien namespace-scoped token (cloud — local instances) */
  cloudToken?: string;
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
      const { Oblien } = await import("oblien");
      const { CloudRuntime } = await import("./cloud");
      const client = opts.cloudToken
        ? new Oblien({ token: opts.cloudToken })
        : new Oblien({
            clientId: opts.cloudClientId ?? process.env.OBLIEN_CLIENT_ID ?? "",
            clientSecret: opts.cloudClientSecret ?? process.env.OBLIEN_CLIENT_SECRET ?? "",
          });
      return new CloudRuntime(client);
    }
  }
}
