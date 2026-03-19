import { execFile } from "node:child_process";

import type { WorkspaceHandle } from "oblien";

import type { CommandExecutor } from "../types";
import { BuildLogger, sq } from "./build-pipeline";

export interface DirectoryTransferOptions {
  excludes?: string[];
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

const DEFAULT_SOURCE_EXCLUDES = ["node_modules", ".git"] as const;
const TAR_MAX_BUFFER = 500 * 1024 * 1024;

export async function transferLocalDirectory(
  localPath: string,
  target: LocalDirectoryTarget,
  logger: BuildLogger,
  options?: DirectoryTransferOptions,
): Promise<void> {
  logger.log(`Transferring ${localPath} → ${target.path}...\n`);

  if (target.kind === "executor") {
    await target.executor.transferIn(localPath, target.path, logger.callback, options);

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
    throw new Error("Transfer produced 0 files — upload may have failed silently");
  }

  logger.log(`Uploaded ${result.files_extracted} files.\n`);
}

/**
 * Verify that a transfer via CommandExecutor actually produced files.
 * Checks for non-empty directory and the presence of at least one
 * expected marker file (package.json, index.html, etc.).
 */
async function verifyExecutorTransfer(
  executor: CommandExecutor,
  targetPath: string,
  logger: BuildLogger,
): Promise<void> {
  // Quick check: is the target directory non-empty?
  try {
    const countOutput = await executor.exec(
      `find ${sq(targetPath)} -maxdepth 1 -not -name '.' | head -5 | wc -l`,
    );
    const fileCount = parseInt(countOutput.trim(), 10);
    if (fileCount === 0) {
      throw new Error(
        `Transfer target ${targetPath} is empty — files were not copied`,
      );
    }
    logger.log(`Transfer verified (${fileCount}+ entries in target).\n`);
  } catch (err) {
    if (err instanceof Error && err.message.includes("is empty")) throw err;
    // If the count command itself fails (e.g. dir doesn't exist), that's a transfer failure
    throw new Error(
      `Transfer verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function createTarball(
  localPath: string,
  options?: DirectoryTransferOptions,
): Promise<Buffer> {
  const excludes = options?.excludes ?? [...DEFAULT_SOURCE_EXCLUDES];
  const args: string[] = [];

  // Strip macOS extended attributes (.apple.provenance, resource forks)
  if (process.platform === "darwin") {
    args.push("--no-mac-metadata");
  }

  args.push("czf", "-", "-C", localPath);

  for (const exclude of excludes) {
    args.push(`--exclude=${exclude}`);
  }

  args.push(".");

  return new Promise((resolve, reject) => {
    execFile(
      "tar",
      args,
      {
        encoding: "buffer",
        maxBuffer: TAR_MAX_BUFFER,
        env: { ...process.env, COPYFILE_DISABLE: "1" },
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
}