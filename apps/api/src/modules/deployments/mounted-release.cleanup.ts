import type { CommandExecutor } from "@repo/adapters";
import { shellQuote, safeErrorMessage } from "@repo/core";
import { repos, type Project } from "@repo/db";
import { resolveServerExecutor } from "../../lib/deployment-runtime";
import { mountedReleaseConfig, mountedReleaseHostRoot } from "./mounted-release.config";
import {
  classifyMountedReleaseHostPath,
  isFilesystemArtifactRef,
  isMountedReleaseRow,
  releaseBuilderName,
  removeReleaseTreeCommand,
  retainedMountedReleaseIds,
} from "./release-artifact";

const IN_FLIGHT = new Set(["queued", "building", "deploying"]);

export async function removeHostPath(
  executor: Pick<CommandExecutor, "exec" | "rm">,
  path: string,
): Promise<void> {
  if (!isFilesystemArtifactRef(path) || path.includes("..")) return;
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
  ownedIds: string[];
}> {
  const { rows } = await repos.deployment.listByProject(project.id, { perPage: 1000 });
  const owned = rows.filter((row) => isMountedReleaseRow(row));
  const ready = owned
    .filter((row) => row.status === "ready")
    .sort((a, b) => {
      const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      return bt - at;
    });
  const inFlightIds = owned.filter((row) => IN_FLIGHT.has(row.status)).map((row) => row.id);
  const retain = mountedReleaseConfig(project)?.retain ?? 5;
  return {
    keep: retainedMountedReleaseIds({
      readyNewestFirst: ready,
      activeReleaseId: project.activeReleaseDeploymentId,
      inFlightIds,
      retain,
    }),
    inFlightIds,
    ownedIds: owned.map((row) => row.id),
  };
}

/** Remove leftover incoming/auth dirs, unused release trees, and stale builders. */
export async function sweepMountedReleaseHost(
  executor: Pick<CommandExecutor, "exec" | "rm">,
  project: Project,
): Promise<{ removed: string[] }> {
  const hostRoot = mountedReleaseHostRoot(project.id);
  const { keep, inFlightIds, ownedIds } = await keepReleaseIdsFor(project);
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

  const ownedBuilders = new Set(ownedIds.map((id) => releaseBuilderName(id)));
  const protectBuilders = new Set(inFlightIds.map((id) => releaseBuilderName(id)));
  const builderNames = lines(
    await executor
      .exec(`docker ps -a --filter name=openship-release- --format '{{.Names}}' 2>/dev/null || true`)
      .catch(() => ""),
  );
  for (const name of builderNames) {
    if (!ownedBuilders.has(name) || protectBuilders.has(name)) continue;
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
