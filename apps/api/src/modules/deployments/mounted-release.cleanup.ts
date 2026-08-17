import type { CommandExecutor } from "@repo/adapters";
import { shellQuote, safeErrorMessage } from "@repo/core";
import { repos, type Project } from "@repo/db";
import { resolveServerExecutor } from "../../lib/deployment-runtime";
import { mountedReleaseConfig, mountedReleaseHostRoot } from "./mounted-release.config";
import {
  classifyMountedReleaseHostPath,
  isFilesystemArtifactRef,
  isProtectedMountedReleaseFilesystem,
  releaseBuilderName,
  removeReleaseTreeCommand,
  retainedMountedReleaseIds,
} from "./release-artifact";

export async function removeHostPath(
  executor: Pick<CommandExecutor, "exec" | "rm">,
  path: string,
): Promise<void> {
  if (!isFilesystemArtifactRef(path) || path.includes("..")) return;
  if (isProtectedMountedReleaseFilesystem(path)) return;
  await executor.exec(removeReleaseTreeCommand(path)).catch(() => {});
}

function lines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function keepReleaseIdsFor(project: Project): Promise<{
  keep: Set<string>;
  inFlightIds: string[];
}> {
  const ready = await repos.deployment.listReadyOrderedDesc(project.id);
  const inFlight = await repos.deployment.findInFlightByProject(project.id);
  const inFlightIds = inFlight ? [inFlight.id] : [];
  const retain = mountedReleaseConfig(project)?.retain ?? 5;
  return {
    keep: retainedMountedReleaseIds({
      readyNewestFirst: ready,
      activeReleaseId: project.activeReleaseDeploymentId,
      inFlightIds,
      retain,
    }),
    inFlightIds,
  };
}

/** Remove leftover incoming/auth dirs, unused release trees, and stale builders. */
export async function sweepMountedReleaseHost(
  executor: Pick<CommandExecutor, "exec" | "rm">,
  project: Project,
): Promise<{ removed: string[] }> {
  const hostRoot = mountedReleaseHostRoot(project.id);
  const { keep, inFlightIds } = await keepReleaseIdsFor(project);
  const removed: string[] = [];

  const listed = lines(
    await executor
      .exec(
        `find ${shellQuote(hostRoot)} -mindepth 1 -maxdepth 1 \\( -name '.incoming-*' -o -name '.auth-*' \\) 2>/dev/null; ` +
          `find ${shellQuote(`${hostRoot}/releases`)} -mindepth 1 -maxdepth 1 2>/dev/null || true`,
      )
      .catch(() => ""),
  );

  for (const path of listed) {
    if (classifyMountedReleaseHostPath(hostRoot, path, keep) !== "remove") continue;
    await removeHostPath(executor, path);
    removed.push(path);
  }

  const protectBuilders = new Set(inFlightIds.map((id) => releaseBuilderName(id)));
  const builderNames = lines(
    await executor
      .exec(`docker ps -a --filter name=openship-release- --format '{{.Names}}' 2>/dev/null || true`)
      .catch(() => ""),
  );
  for (const name of builderNames) {
    if (!name.startsWith("openship-release-") || protectBuilders.has(name)) continue;
    const row = await repos.deployment.findById(name.slice("openship-release-".length)).catch(() => undefined);
    if (!row || row.projectId !== project.id) continue;
    await executor.exec(`docker rm -f ${shellQuote(name)}`).catch(() => {});
  }

  return { removed };
}

export async function sweepMountedReleaseHostSafe(project: Project): Promise<void> {
  if (!mountedReleaseConfig(project) && !project.activeReleaseDeploymentId) return;
  try {
    const { executor } = await resolveServerExecutor(project.serverId ?? undefined, project.organizationId);
    await sweepMountedReleaseHost(executor, project);
  } catch (err) {
    console.warn(
      `[mounted-release] sweep skipped for project ${project.id}: ${safeErrorMessage(err)}`,
    );
  }
}
