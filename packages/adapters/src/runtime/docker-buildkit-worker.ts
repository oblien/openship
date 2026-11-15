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
  const workers = [
    [buildKitWorker(projectId, "openship-"), false],
    [projectBuildKitWorker(projectId), true],
  ] as const;
  const receipt = "OPENSHIP_BUILD_WORKERS_STOPPED";
  // Run the complete reconciliation beside Docker. Repeated lifecycle checks
  // still query the daemon, but no longer require four or more remote commands.
  const script = [
    "set -eu",
    ...workers.flatMap(([worker, keepState]) => {
      const { builderName, containerName } = worker;
      const list = `docker container ls --all --filter ${sq(`name=^/${containerName}$`)} --format ${sq("{{.Names}}")}`;
      return [
        // Buildx metadata can remain after an interrupted client even if its
        // container is gone. Remove it without treating its exit code as proof.
        `docker buildx rm --force${keepState ? " --keep-state" : ""} ${sq(builderName)} >/dev/null 2>&1 || true`,
        `names="$(${list})"`,
        `case "$names" in`,
        "  '') ;;",
        `  ${sq(containerName)})`,
        `    docker container rm --force ${sq(containerName)} >/dev/null 2>&1 || true`,
        `    names="$(${list})"`,
        '    test -z "$names" ;;',
        "  *) exit 1 ;;",
        "esac",
      ];
    }),
    `printf '%s\\n' ${sq(receipt)}`,
  ].join("\n");
  try {
    const output = await executor.exec(script);
    if (!output.split(/\r?\n/).includes(receipt))
      throw new Error("Docker did not confirm build worker shutdown");
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
