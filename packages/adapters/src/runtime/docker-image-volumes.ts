import { createHash } from "node:crypto";
import { posix } from "node:path";
import type Dockerode from "dockerode";
import { formatVolumeMount, parseVolumeMount } from "@repo/core";
import { isRuntimeNotFoundError } from "../system/errors";
import { OPENSHIP_LABEL, isBuildHelperMarkers } from "../system/port-owner";
import { projectVolumePrefix, ensureProjectVolume } from "./docker-project-volume";

/** A destination belongs to a workload, not to a particular image or release. */
export function imageVolumeName(workload: string, destination: string): string {
  const key = createHash("sha256").update(`${workload}:${destination}`).digest("hex").slice(0, 24);
  return `data-${key}`;
}

type VolumeOwner = {
  projectId: string;
  workload: string;
  previous?: { containerId: string; serviceName?: string; required?: boolean };
  /** A scheduler verifies its release ownership before returning the saved mounts. */
  readPrevious?: () => Promise<Pick<Dockerode.ContainerInspectInfo, "Mounts"> | undefined>;
};

/**
 * Complete explicit binds with persistent image/anonymous volumes. Resolve while
 * the outgoing container still exists; never infer an old database from a loose
 * name/prefix search or create an empty replacement for missing recorded storage.
 */
export async function resolveImageVolumeBinds(
  docker: Pick<Dockerode, "getContainer" | "getVolume" | "createVolume">,
  declared: readonly string[],
  imageVolumes: readonly string[],
  owner: VolumeOwner,
): Promise<string[]> {
  const destination = (target: string) => {
    if (!target.startsWith("/") || target.includes(":"))
      throw new Error(`Invalid persistent volume destination: ${target}`);
    return posix.normalize(target).replace(/\/$/, "") || "/";
  };
  const mounts = declared.map((raw) => {
    const mount = parseVolumeMount(raw);
    return { ...mount, target: destination(mount.target) };
  });
  const targets = new Map(
    mounts.filter((mount) => !mount.source).map((mount) => [mount.target, mount.options]),
  );
  for (const raw of imageVolumes) {
    const target = destination(raw);
    if (!targets.has(target)) targets.set(target, []);
  }
  for (const mount of mounts) if (mount.source) targets.delete(mount.target);
  const binds = mounts.filter((mount) => mount.source).map(formatVolumeMount);
  if (!targets.size) return binds;
  let previous: Pick<Dockerode.ContainerInspectInfo, "Mounts"> | undefined =
    await owner.readPrevious?.();
  let previousLabels: Record<string, string> | undefined;
  if (owner.previous) {
    try {
      const container = await docker.getContainer(owner.previous.containerId).inspect();
      previous = container;
      previousLabels = container.Config.Labels ?? {};
    } catch (error) {
      if (!isRuntimeNotFoundError(error)) throw error;
      if (owner.previous.required !== false)
        throw new Error(
          "The previous container is missing. Recover its persistent volume mapping before redeploying; no empty replacement was created.",
          { cause: error },
        );
    }
  }
  if (previous && owner.previous) {
    const labels = previousLabels ?? {};
    if (
      labels[OPENSHIP_LABEL.project] !== owner.projectId ||
      (owner.previous.serviceName &&
        labels[OPENSHIP_LABEL.service] !== owner.previous.serviceName) ||
      labels[OPENSHIP_LABEL.role] ||
      isBuildHelperMarkers({
        build: labels[OPENSHIP_LABEL.build],
        deployment: labels[OPENSHIP_LABEL.deployment],
        service: labels[OPENSHIP_LABEL.service],
      })
    ) {
      throw new Error(
        "The previous container's storage ownership could not be verified; no volumes were changed.",
      );
    }
  }

  const toCreate: string[] = [];
  for (const [target, options] of targets) {
    const existing = previous?.Mounts.filter((mount) => mount.Destination === target) ?? [];
    if (existing.length > 1)
      throw new Error(`More than one previous mount matches ${target}; no volumes were changed.`);
    const mount = existing[0];
    if (mount) {
      if (mount.Type !== "volume" || !mount.Name)
        throw new Error(`Configure the existing mount at ${target} explicitly before redeploying.`);
      // Docker otherwise creates a missing named volume empty on container-create.
      const volume = await docker.getVolume(mount.Name).inspect();
      if (
        volume.Labels?.[OPENSHIP_LABEL.project] &&
        volume.Labels[OPENSHIP_LABEL.project] !== owner.projectId
      )
        throw new Error(`The existing volume at ${target} belongs to another project.`);
      binds.push(
        formatVolumeMount({
          source: mount.Name,
          target,
          options: options.length
            ? options
            : mount.Mode
              ? mount.Mode.split(",")
              : mount.RW === false
                ? ["ro"]
                : [],
        }),
      );
      continue;
    }
    const name = `${projectVolumePrefix(owner.projectId)}${imageVolumeName(owner.workload, target)}`;
    toCreate.push(name);
    binds.push(formatVolumeMount({ source: name, target, options }));
  }
  for (const name of toCreate) {
    if (!(await ensureProjectVolume(docker, name, owner.projectId)))
      throw new Error("A persistent volume belongs to another project; no container was replaced.");
  }
  return binds;
}
