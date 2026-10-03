import type Dockerode from "dockerode";
import { AppError } from "@repo/core";

/** Creating an existing Docker volume returns it unchanged. Always inspect the
 * persisted ownership after creation, including when another request raced us. */
export async function ensureCloudProjectVolume(docker: Pick<Dockerode, "getVolume" | "createVolume">, name: string, projectId: string) {
  let volume;
  try {
    volume = await docker.getVolume(name).inspect();
  } catch (error) {
    if ((error as { statusCode?: number; status?: number }).statusCode !== 404 &&
        (error as { status?: number }).status !== 404) throw error;
    await docker.createVolume({ Name: name, Labels: { "openship.project": projectId } });
    volume = await docker.getVolume(name).inspect();
  }
  if (volume.Labels?.["openship.project"] !== projectId)
    throw new AppError("A volume with this name belongs to another project. Choose a different name.", 409, "CLOUD_VOLUME_CONFLICT");
}
