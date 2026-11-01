import { createHash } from "node:crypto";
import type Dockerode from "dockerode";

/** Immutable project identity, independent of a reusable app/organization slug. */
export function projectVolumePrefix(projectId: string): string {
  return `openship-project-${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}-`;
}

/** Docker create is idempotent but does not replace an existing volume's labels.
 * Read ownership back after creation, including when another request raced us. */
export async function ensureProjectVolume(
  docker: Pick<Dockerode, "getVolume" | "createVolume">,
  name: string,
  projectId: string,
): Promise<boolean> {
  let volume;
  try {
    volume = await docker.getVolume(name).inspect();
  } catch (error) {
    const status = error as { statusCode?: number; status?: number } | null;
    if (status?.statusCode !== 404 && status?.status !== 404) throw error;
    await docker.createVolume({ Name: name, Labels: { "openship.project": projectId } });
    volume = await docker.getVolume(name).inspect();
  }
  return volume.Labels?.["openship.project"] === projectId;
}
