import type Dockerode from "dockerode";
import { AppError } from "@repo/core";
import { ensureScopedVolumeName } from "../volume-namespace";
import { projectVolumePrefix, ensureProjectVolume } from "../docker-project-volume";

async function inspectVolume(docker: Pick<Dockerode, "getVolume">, name: string) {
  try {
    return await docker.getVolume(name).inspect();
  } catch (error) {
    const status = error as { statusCode?: number; status?: number } | null;
    if (status?.statusCode === 404 || status?.status === 404) return null;
    throw error;
  }
}

/** Resolve without creating storage, so deployment and container-less backups
 * select the same volume. Keep owned legacy/imported names; fresh logical names
 * use the immutable project ID. Never adopt or alter another project's data. */
export async function resolveCloudProjectVolumeName(
  docker: Pick<Dockerode, "getVolume" | "listContainers">,
  projectId: string,
  slug: string,
  source: string,
): Promise<string> {
  const prefix = projectVolumePrefix(projectId);
  // Concrete names persisted by an import or read from our own mounts retain
  // their identity. The caller must still verify ownership before using them.
  if (source.startsWith(prefix) || source.startsWith(`openship-${slug}-`)) return source;

  const name = `${prefix}${source}`;
  if (await inspectVolume(docker, name)) return name;
  const legacy = ensureScopedVolumeName(slug, source);
  const volume = await inspectVolume(docker, legacy);
  if (volume?.Labels?.["openship.project"] === projectId) return legacy;
  if (volume) {
    // An existing workload pointing at disputed storage must fail before
    // cutover, instead of silently switching to an empty database.
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`openship.project=${projectId}`], volume: [legacy] },
    });
    if (
      containers.some(
        (container) =>
          container.Labels?.["openship.project"] === projectId &&
          container.Mounts?.some((mount) => mount.Type === "volume" && mount.Name === legacy),
      )
    )
      throw new AppError(
        "An existing workload uses a volume whose project ownership cannot be verified. Repair or import its storage before redeploying.",
        409,
        "CLOUD_VOLUME_CONFLICT",
      );
  }
  return name;
}
/** Creating an existing Docker volume returns it unchanged. Always inspect the
 * persisted ownership after creation, including when another request raced us. */
export async function ensureCloudProjectVolume(docker: Pick<Dockerode, "getVolume" | "createVolume">, name: string, projectId: string) {
  if (!await ensureProjectVolume(docker, name, projectId))
    throw new AppError("A volume with this name belongs to another project. Choose a different name.", 409, "CLOUD_VOLUME_CONFLICT");
}
