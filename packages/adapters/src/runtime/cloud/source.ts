import { posix } from "node:path";
import type { BuildConfig } from "../../types";
import type { BuildLogger } from "../build-pipeline";
import type { CloudServerConnection } from "./server-connection";

/** Transfer supplied source to a managed host; Git acquisition stays in the shared build engine. */
export async function prepareManagedSource(
  connection: CloudServerConnection,
  config: BuildConfig,
  directory: string,
  logger: BuildLogger,
): Promise<boolean> {
  if (config.inlineSourceFiles) {
    const files = config.inlineSourceFiles.map((file) => {
      if (
        typeof file.path !== "string" ||
        typeof file.content !== "string" ||
        file.path.includes("\0")
      )
        throw new Error("Invalid source file");
      const relative = file.path.replaceAll("\\", "/");
      const path = posix.resolve(directory, relative);
      if (posix.isAbsolute(relative) || !path.startsWith(`${directory}/`))
        throw new Error("Source file escapes its project directory");
      return { path, content: file.content };
    });
    for (const file of files) await connection.executor.writeFile(file.path, file.content);
    return true;
  }
  if (!config.sourceTransfer) return false;
  await config.sourceTransfer(connection.executor, directory, logger.callback);
  return true;
}
