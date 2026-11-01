import { posix } from "node:path";
import { AppError } from "@repo/core";
import type { CommandExecutor } from "../types";
import { privilegedExecutor } from "../system/privilege";
import { DOCKER_BUILD_STORAGE_COMMAND, dockerBuildStorageCommand } from "./docker-build-cache";

/** Elevate only trusted cache filesystem I/O. Buildx, repository files and image
 * acquisition retain the login user's Docker context and executor. */
export async function protectedBuildCacheHostExecutor(
  executor: CommandExecutor,
): Promise<CommandExecutor> {
  const grant = await privilegedExecutor(executor, "Managing remote Docker build cache", {
    onRefusedHost: "proceed",
  });
  if (!grant.supported || grant.value.elevation === "none")
    throw new AppError(
      "Remote build cache requires root or passwordless sudo on the server. " +
        (grant.supported ? "This login cannot access Docker's host storage." : grant.reason),
      503,
      "BUILD_METADATA_PROTECTION_UNAVAILABLE",
    );
  if (grant.value.elevation === "root") return executor;
  const host = grant.value.executor;
  return new Proxy(host, {
    get(target, key, receiver) {
      if (key === "exec")
        return async (command: string, options?: Parameters<CommandExecutor["exec"]>[1]) => {
          if (command !== DOCKER_BUILD_STORAGE_COMMAND) return host.exec(command, options);
          // Resolve through the original client; sudo can select a different
          // Docker context. Only df against the quoted daemon path needs root.
          const root = (
            await executor.exec("docker info --format '{{.DockerRootDir}}'", options)
          ).trim();
          if (!posix.isAbsolute(root) || /[\r\n\0]/.test(root))
            throw new AppError(
              "Docker returned an invalid host storage path",
              503,
              "BUILD_STORAGE_UNKNOWN",
            );
          return host.exec(dockerBuildStorageCommand(root), options);
        };
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
