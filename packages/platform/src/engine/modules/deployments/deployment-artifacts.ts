import { DockerRuntime, type RuntimeAdapter } from "@repo/adapters";
import { repos, type Deployment } from "@repo/db";
import { hasRelativeVolumeMounts } from "@repo/core";

/** A completed Docker build, recorded by the worker, never accepted from clients. */
export interface DeploymentArtifacts {
  version: 1;
  images: Array<{ imageRef: string; imageId: string; serviceId?: string; serviceName?: string }>;
}

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

/** The normal pipeline replays saved runtime configuration for these attempts. */
export function replaysFrozenDeployment(dep: { trigger?: string | null; meta?: unknown }): boolean {
  return (
    dep.trigger === "rollback" ||
    typeof (dep.meta as { retryBuildFromDeploymentId?: unknown } | null)
      ?.retryBuildFromDeploymentId === "string"
  );
}

export function deploymentArtifacts(meta: unknown): DeploymentArtifacts | undefined {
  const value = (meta as { completedBuildArtifacts?: DeploymentArtifacts } | null)
    ?.completedBuildArtifacts;
  if (value?.version !== 1 || !Array.isArray(value.images) || !value.images.length) return;
  const services = new Set<string>();
  const names = new Set<string>();
  const hasServices = value.images.some((image) => image?.serviceId !== undefined);
  for (const image of value.images) {
    if (
      !image ||
      typeof image.imageRef !== "string" ||
      !image.imageRef.trim() ||
      !IMAGE_ID.test(image.imageId)
    )
      return;
    if (hasServices || image.serviceId !== undefined || image.serviceName !== undefined) {
      if (
        typeof image.serviceId !== "string" ||
        !image.serviceId ||
        typeof image.serviceName !== "string" ||
        !image.serviceName ||
        services.has(image.serviceId) ||
        names.has(image.serviceName)
      )
        return;
      services.add(image.serviceId);
      names.add(image.serviceName);
    } else if (value.images.length !== 1) return;
  }
  return value;
}

export function hasRetryableBuild(
  dep: Pick<Deployment, "status" | "meta" | "artifactRetainedAt">,
): boolean {
  return (
    (dep.status === "failed" || dep.status === "action_required") &&
    !!dep.artifactRetainedAt &&
    !!deploymentArtifacts(dep.meta)
  );
}

/** Inspection only: never pulls an image or makes build failure a success. */
export async function recordDeploymentArtifacts(
  dep: Deployment,
  runtime: RuntimeAdapter,
  images: Array<Omit<DeploymentArtifacts["images"][number], "imageId">>,
): Promise<DeploymentArtifacts | undefined> {
  if (
    !(runtime instanceof DockerRuntime) ||
    !images.length ||
    images.some((i) => i.imageRef.startsWith("/"))
  )
    return;
  const services = (dep.meta as { composeServices?: Array<{ volumes?: string[] }> } | null)
    ?.composeServices;
  if (services?.some((service) => hasRelativeVolumeMounts(service.volumes))) return;
  const receipt: DeploymentArtifacts = { version: 1, images: [] };
  const prior = deploymentArtifacts(dep.meta);
  for (const image of images) {
    const prepared = await runtime.prepareDeploymentImage(image.imageRef, { requirePresent: true });
    const source = prior?.images.find(
      (saved) => saved.imageId === prepared.imageId && saved.serviceId === image.serviceId,
    );
    receipt.images.push({
      ...image,
      imageRef: source?.imageRef ?? image.imageRef,
      imageId: prepared.imageId,
    });
  }
  if (!(await repos.deployment.recordCompletedBuildArtifacts(dep.id, dep.organizationId, receipt)))
    return;
  dep.meta = { ...((dep.meta as Record<string, unknown>) ?? {}), completedBuildArtifacts: receipt };
  dep.artifactRetainedAt = new Date();
  return receipt;
}

export function artifactReferences(receipt: DeploymentArtifacts): Set<string> {
  return new Set(receipt.images.flatMap((image) => [image.imageId, image.imageRef]));
}
