/**
 * Shared local build — build on the API host, then hand off output.
 *
 * When buildStrategy="local", both BareRuntime and CloudRuntime need
 * the same sequence:
 *   1. Create a temporary build directory on the API host
 *   2. Set up a BuildEnvironment backed by a LocalExecutor
 *   3. Run the shared pipeline (clone → install → build)
 *   4. Let the runtime transfer the output to the target (SSH / cloud upload)
 *   5. Clean up the local build directory
 *
 * This module encapsulates steps 1-5 so each runtime only provides
 * the transfer callback and optional preflight hooks.
 */

import type { BuildConfig, CommandExecutor } from "../types";
import { LocalExecutor } from "../system/executor";
import {
  BuildLogger,
  runBuildPipeline,
  type BuildEnvironment,
  type BuildPipelineResult,
} from "./build-pipeline";
import { transferLocalDirectory } from "./transfer";

const LOCAL_BUILD_DIR = "/tmp/openship/.builds";

// ─── Options ─────────────────────────────────────────────────────────────────

export interface LocalBuildOptions {
  config: BuildConfig;
  logger: BuildLogger;

  /** AbortSignal for build cancellation. */
  abort?: AbortSignal;

  /**
   * Extra preflight logic that runs before the shared pipeline.
   * Receives the local executor so callers can run toolchain checks, etc.
   */
  preflight?: (
    config: BuildConfig,
    logger: BuildLogger,
    localExec: CommandExecutor,
  ) => Promise<void>;

  /**
   * Called after a successful build with the path to the local build output.
   * Transfer/upload the output to the target here (SSH, Oblien API, etc.).
   * Runs BEFORE cleanup of the local build directory.
   */
  transferOutput: (buildDir: string) => Promise<void>;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function runLocalBuild(
  opts: LocalBuildOptions,
): Promise<BuildPipelineResult> {
  const { config, logger, abort } = opts;
  const localExec = new LocalExecutor();
  const buildDir = `${LOCAL_BUILD_DIR}/${config.sessionId}`;

  await localExec.rm(buildDir);
  await localExec.mkdir(buildDir);

  const buildEnv: BuildEnvironment = {
    projectDir: buildDir,
    exec: async (command, logCb) => {
      if (abort?.aborted) throw new Error("Build cancelled");
      const { code } = await localExec.streamExec(command, logCb);
      if (abort?.aborted) throw new Error("Build cancelled");
      if (code !== 0) {
        throw new Error(`Command failed with exit code ${code}`);
      }
    },
    preflight: async (cfg, plog) => {
      if (abort?.aborted) throw new Error("Build cancelled");

      // Runtime-specific preflight (toolchain checks, etc.)
      if (opts.preflight) {
        await opts.preflight(cfg, plog, localExec);
      }

      // Transfer local project source into the build directory
      if (cfg.localPath) {
        await transferLocalDirectory(
          cfg.localPath,
          {
            kind: "executor",
            executor: localExec,
            path: buildDir,
          },
          plog,
        );
      }
    },
  };

  try {
    const result = await runBuildPipeline(buildEnv, config, logger);

    if (result.status === "deploying") {
      await opts.transferOutput(buildDir);
    }

    return result;
  } finally {
    await localExec.rm(buildDir).catch(() => {});
    await localExec.dispose();
  }
}
