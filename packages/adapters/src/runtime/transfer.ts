import { execFile } from "node:child_process";

import type { WorkspaceHandle } from "oblien";

import type { CommandExecutor } from "../types";
import { BuildLogger } from "./build-pipeline";

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
    logger.log("Transfer complete.\n");
    return;
  }

  const tarBuffer = await createTarball(localPath, options);
  const result = await target.runtime.transfer.upload({
    body: tarBuffer,
    dest: target.path,
  });

  logger.log(`Uploaded ${result.files_extracted} files.\n`);
}

async function createTarball(
  localPath: string,
  options?: DirectoryTransferOptions,
): Promise<Buffer> {
  const excludes = options?.excludes ?? [...DEFAULT_SOURCE_EXCLUDES];
  const args = ["czf", "-", "-C", localPath];

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