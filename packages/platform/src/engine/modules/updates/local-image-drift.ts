import { reportCaughtError } from "@repo/core/diagnostics";
import { resolveUnknownDigestDrift, withTimeout } from "@repo/core";
import { DockerRuntime } from "@repo/adapters";
import { repos, type Project, type ServiceDeployment } from "@repo/db";
import { findActiveDeployment } from "../../lib/active-deployment";
import { mapWithLimit } from "../../lib/map-with-limit";
import type { DriftStatus } from "../projects/project-crud.service";

type ImageDriftStatus = Extract<DriftStatus, { mode: "image" }>;
type ImageDriftService = ImageDriftStatus["services"][number];
const SOURCE = "platform/engine/modules/updates/local-image-drift";
const INSPECTION_BUDGET_MS = 3_000;

/** Observe missing deployment identities without pulling images or changing rows. */
export async function verifyUnknownImageDrift(
  project: Project,
  status: ImageDriftStatus,
  deadline = Date.now() + INSPECTION_BUDGET_MS,
): Promise<void> {
  const pending = status.services.filter((service) => service.unknown && !service.deployedDigest);
  if (!pending.length || Date.now() >= deadline) return;
  deadline = Math.min(deadline, Date.now() + INSPECTION_BUDGET_MS);
  const work = async () => {
    const active = await findActiveDeployment(project);
    if (!active || Date.now() >= deadline) return;
    const rows = await repos.service.listByDeployment(active.id);
    // No container to inspect: do not resolve a host or acquire a transport.
    if (
      !rows.some(
        (row) => row.containerId && pending.some((service) => service.serviceId === row.serviceId),
      ) ||
      Date.now() >= deadline
    )
      return;
    const { withDeploymentRuntime } = await import("../../lib/deployment-runtime");
    await withDeploymentRuntime(active, async (runtime) => {
      // The wrapper also releases a runtime that resolves after our deadline.
      if (Date.now() >= deadline || !(runtime instanceof DockerRuntime)) return;
      await verifyUnknownImageServices(runtime, rows, pending, deadline);
    });
  };
  await withTimeout(
    work(),
    Math.max(1, deadline - Date.now()),
    "Image drift inspection timed out",
  ).catch((error) => reportCaughtError(error, SOURCE));
  status.behind = status.services.some((service) => service.behind);
  status.unverified = status.services.some((service) => service.unknown);
}

export async function verifyUnknownImageServices(
  runtime: DockerRuntime,
  rows: ReadonlyArray<Pick<ServiceDeployment, "serviceId" | "containerId">>,
  services: ImageDriftService[],
  deadline = Date.now() + INSPECTION_BUDGET_MS,
): Promise<void> {
  if (!runtime.supports("containerInfo")) return;
  const observe = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
    if (Date.now() >= deadline) return undefined;
    return withTimeout(
      read(),
      Math.max(1, deadline - Date.now()),
      "Image inspection timed out",
    ).catch((error) => {
      reportCaughtError(error, SOURCE);
      return undefined;
    });
  };
  const tags = new Map<
    string,
    Promise<Awaited<ReturnType<DockerRuntime["prepareDeploymentImage"]>> | undefined>
  >();
  await mapWithLimit(services, 3, async (service) => {
    const row = rows.find((candidate) => candidate.serviceId === service.serviceId);
    if (!row?.containerId || Date.now() >= deadline) return;
    const info = await observe(() => runtime.getContainerInfo(row.containerId!));
    if (!info?.imageId || Date.now() >= deadline) return;
    const containerImageId = info.imageId;
    let tag = tags.get(service.ref);
    if (!tag) {
      tag = observe(() => runtime.prepareDeploymentImage(service.ref, { requirePresent: true }));
      tags.set(service.ref, tag);
    }
    const [prepared, containerRegistryDigest] = await Promise.all([
      tag,
      observe(() => runtime.resolveImageDigest(containerImageId, service.ref)),
    ]);
    if (Date.now() >= deadline) return;
    const verdict = resolveUnknownDigestDrift({
      containerImageId,
      containerRegistryDigest,
      tagImageId: prepared?.imageId,
      tagRegistryDigest: prepared?.registryDigest,
      latestDigest: service.latestDigest,
    });
    service.behind ||= verdict.behind;
    service.unknown = verdict.unknown;
    if (verdict.recoveredDigest) service.deployedDigest = verdict.recoveredDigest;
  });
}
