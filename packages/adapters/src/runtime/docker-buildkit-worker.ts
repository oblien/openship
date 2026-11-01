import { createHash } from "node:crypto";
import { AppError } from "@repo/core";
import type { CommandExecutor } from "../types";
import { sq } from "./build-pipeline";

/** Buildx's docker-container driver names its container from the explicit node.
 * Keep compatible with the original single-node builder's implicit `<name>0`. */
function buildKitWorker(projectId: string, prefix: string) {
  if (!projectId) throw new Error("BuildKit worker requires a project identity");
  const builderName = `${prefix}${createHash("sha256").update(projectId).digest("hex").slice(0, 24)}`;
  const nodeName = `${builderName}0`;
  return { builderName, nodeName, containerName: `buildx_buildkit_${nodeName}` };
}

/** Version the worker identity so unlabeled state left by older releases is
 * never mistaken for a managed, retained cache volume. */
export function projectBuildKitWorker(projectId: string) {
  return buildKitWorker(projectId, "openship-cache-");
}

/** Requires exclusive ownership of this project's builds. First stop/recover
 * the issuing commands, so an old buildx client cannot recreate the worker.
 * Docker, not the exec process group, owns this container. CLI metadata absence
 * is not proof of exit; query the daemon and require confirmed container absence. */
export async function removeProjectBuildKitWorker(
  executor: Pick<CommandExecutor, "exec">,
  projectId: string,
): Promise<void> {
  for (const [worker, keepState] of [
    [buildKitWorker(projectId, "openship-"), false],
    [projectBuildKitWorker(projectId), true],
  ] as const) await removeBuildKitWorker(executor, worker, keepState);
}

async function removeBuildKitWorker(
  executor: Pick<CommandExecutor, "exec">,
  { builderName, containerName }: ReturnType<typeof projectBuildKitWorker>,
  keepState: boolean,
): Promise<void> {
  const list = `docker container ls --all --filter ${sq(`name=^/${containerName}$`)} --format ${sq("{{.Names}}")}`;
  const exists = async () => {
    const names = (await executor.exec(list)).trim().split(/\r?\n/).filter(Boolean);
    if (names.some((name) => name !== containerName))
      throw new Error("Docker returned a different build worker identity");
    return names.length > 0;
  };
  try {
    // Buildx state may already be missing. The daemon check below is authoritative.
    // Managed cache GC owns state deletion after the worker is confirmed absent.
    await executor.exec(`docker buildx rm --force${keepState ? " --keep-state" : ""} ${sq(builderName)}`).catch(() => {
      /* diagnostics-ignore: Confirmed daemon absence below supersedes CLI metadata errors. */
    });
    if (await exists()) {
      await executor.exec(`docker container rm --force ${sq(containerName)}`).catch(() => {
        /* diagnostics-ignore: A lost removal reply is resolved by the daemon query below. */
      });
      if (await exists()) throw new Error("Docker still reports the project build worker");
    }
  } catch (cause) {
    throw Object.assign(
      new AppError(
        "Could not confirm the project's BuildKit worker stopped. Build capacity remains reserved until recovery succeeds.",
        503,
        "CLOUD_BUILD_WORKER_EXIT_UNCONFIRMED",
      ),
      { cause },
    );
  }
}
