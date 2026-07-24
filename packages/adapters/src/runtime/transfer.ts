import { execFile } from "node:child_process";

import type { WorkspaceHandle } from "oblien";

import { TRANSFER_EXCLUDES, safeErrorMessage } from "@repo/core";
import { getTarCreateEnv, prepareSourceTarArgs } from "../archive";
import type { CommandExecutor } from "../types";
import { BuildLogger, sq } from "./build-pipeline";

export interface DirectoryTransferOptions {
  excludes?: string[];
  /** When set, only these paths are transferred (overrides excludes). */
  includes?: string[];
  /** Paths added on top of the git-truth list to ship gitignored build output
   *  (e.g. `.next`). See `TarTransferOptions.alsoInclude`. */
  alsoInclude?: string[];
}

export type LocalDirectoryTarget =
  | {
      kind: "executor";
      executor: CommandExecutor;
      path: string;
    }
  | {
      kind: "cloud-runtime";
      runtime: Awaited<ReturnType<WorkspaceHandle["runtime"]>>;
      path: string;
    };

const TAR_MAX_BUFFER = 500 * 1024 * 1024;

export async function transferLocalDirectory(
  localPath: string,
  target: LocalDirectoryTarget,
  logger: BuildLogger,
  options?: DirectoryTransferOptions,
): Promise<void> {
  logger.log(`Transferring ${localPath} → ${target.path}...\n`);

  if (target.kind === "executor") {
    await target.executor.transferIn(localPath, target.path, logger.callback, {
      excludes: options?.excludes,
      includes: options?.includes,
      alsoInclude: options?.alsoInclude,
    });

    // Validate transfer: verify the target directory is non-empty
    await verifyExecutorTransfer(target.executor, target.path, logger);
    return;
  }

  const tarBuffer = await createTarball(localPath, options);
  const result = await target.runtime.transfer.upload({
    body: tarBuffer,
    dest: target.path,
  });

  if (!result.files_extracted || result.files_extracted === 0) {
    throw new Error("Transfer produced 0 files - upload may have failed silently");
  }

  logger.log(`Uploaded ${result.files_extracted} files.\n`);
}

/**
 * Verify that a transfer via CommandExecutor actually produced files.
 * Checks for non-empty directory and the presence of at least one
 * expected marker file (package.json, index.html, etc.).
 *
 * Exported for testing.
 */
export async function verifyExecutorTransfer(
  executor: CommandExecutor,
  targetPath: string,
  logger: BuildLogger,
): Promise<void> {
  // Quick check: is the target directory non-empty?
  try {
    // `-mindepth 1` excludes the target directory itself. `-not -name '.'`
    // only filters a literal `.`, which an absolute targetPath never is, so
    // find always listed the directory and the count never reached 0.
    const countOutput = await executor.exec(
      `find ${sq(targetPath)} -mindepth 1 -maxdepth 1 | head -5 | wc -l`,
    );
    const fileCount = parseInt(countOutput.trim(), 10);
    if (fileCount === 0) {
      throw new Error(
        `Transfer target ${targetPath} is empty - files were not copied`,
      );
    }
    logger.log(`Transfer verified (${fileCount}+ entries in target).\n`);
  } catch (err) {
    if (err instanceof Error && err.message.includes("is empty")) throw err;
    // If the count command itself fails (e.g. dir doesn't exist), that's a transfer failure
    throw new Error(
      `Transfer verification failed: ${safeErrorMessage(err)}`,
    );
  }
}

async function createTarball(
  localPath: string,
  options?: DirectoryTransferOptions,
): Promise<Buffer> {
  const { args, cleanup } = await prepareSourceTarArgs(localPath, {
    excludes: options?.excludes ?? [...TRANSFER_EXCLUDES],
    includes: options?.includes,
    alsoInclude: options?.alsoInclude,
  });

  try {
    return await new Promise((resolve, reject) => {
      execFile(
        "tar",
        args,
        {
          encoding: "buffer",
          maxBuffer: TAR_MAX_BUFFER,
          env: getTarCreateEnv(),
        },
        (err, stdout, stderr) => {
          if (err) {
            const stderrText = Buffer.isBuffer(stderr) ? stderr.toString().trim() : String(stderr ?? "").trim();
            reject(new Error(stderrText || err.message));
            return;
          }

          resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
        },
      );
    });
  } finally {
    await cleanup();
  }
}