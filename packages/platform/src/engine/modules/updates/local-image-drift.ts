/**
 * Resolve image services whose deployed digest is unknown against the live
 * daemon, before any surface renders them.
 *
 * `evaluateDrift` compares the database row with the registry. When the active
 * row has no `image_digest` — a carried `:latest` service loses it on the
 * upsert, see `service.repo.upsertServiceDeployment` — that comparison cannot
 * speak for the service, so it is marked `unknown` rather than up to date.
 * The row is not the running container, though: the daemon knows what image
 * the container was created from, and what the configured tag resolves to
 * right now. That is the same test the deploy pipeline uses before carrying
 * an unchanged service ("compare actual content, not the mutable tag or an old
 * database digest").
 *
 * Read-only and fail-soft by design: a container that is gone, a tag the
 * daemon does not have, an unreachable runtime — any of those leaves the
 * service `unknown` instead of failing the feed. The only write is healing
 * the row when the local check recovers a digest for an image the container
 * provably runs, so the next read takes the normal digest path.
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { withTimeout } from "@repo/core";
import { DockerRuntime } from "@repo/adapters";
import { resolveUnknownDigestDrift } from "@repo/core";
import { repos, type Project, type ServiceDeployment } from "@repo/db";
import { findActiveDeployment, listActiveServiceDeployments } from "../../lib/active-deployment";
import type { DriftStatus } from "../projects/project-crud.service";

type ImageDriftStatus = Extract<DriftStatus, { mode: "image" }>;
type ImageDriftService = ImageDriftStatus["services"][number];

/** A local daemon answers in milliseconds; never let one stall the feed. */
const CONTAINER_INSPECT_MS = 5_000;
const TAG_RESOLVE_MS = 10_000;
const RUNTIME_RESOLVE_MS = 5_000;

/**
 * Verify every `unknown` service of an image-mode drift status against the
 * live daemon. Mutates `status` in place — `evaluateDrift` returns a fresh
 * object per call — and recomputes `behind` / `unverified` from the resolved
 * services. Never throws: anything it cannot determine stays `unknown`.
 */
export async function verifyUnknownImageDrift(
  project: Project,
  status: ImageDriftStatus,
): Promise<void> {
  const pending = status.services.filter((service) => service.unknown);
  if (pending.length === 0) return;
  const active = await findActiveDeployment(project).catch((diagnosticFailure) => {
    observeCaughtError(diagnosticFailure, "platform/engine/modules/updates/local-image-drift");
    return undefined;
  });
  if (!active) return;
  const rows = await listActiveServiceDeployments(project).catch((diagnosticFailure) => {
    observeCaughtError(diagnosticFailure, "platform/engine/modules/updates/local-image-drift");
    return [];
  });
  // Lazy: `deployment-runtime` pulls the billing service, whose module
  // evaluates the boot-time env guards (INTERNAL_TOKEN outside desktop).
  // This module must stay importable by unit tests and by callers that
  // never touch a daemon — the same reason `security-refresh-guard`
  // lazily imports `build.service`. By the time this runs, the API has
  // already booted, so the guards have passed.
  const { disposeRuntime, resolveDeploymentRuntimeForRead } = await import(
    "../../lib/deployment-runtime"
  );
  const resolved = await withTimeout(
    resolveDeploymentRuntimeForRead(active),
    RUNTIME_RESOLVE_MS,
    "Deployment runtime resolution timed out",
  ).catch((diagnosticFailure) => {
    observeCaughtError(diagnosticFailure, "platform/engine/modules/updates/local-image-drift");
    return null;
  });
  if (!resolved) return;
  const { runtime } = resolved;
  try {
    await verifyUnknownImageServices(runtime, rows, pending);
  } finally {
    disposeRuntime(runtime);
  }
  status.behind = status.services.some((service) => service.behind);
  status.unverified = status.services.some((service) => service.unknown);
}

/**
 * The per-service check, separated from runtime resolution so tests can drive
 * it with a stubbed Docker runtime and no daemon or database. `persist` heals
 * a recovered digest onto the active row; defaults to the service repo.
 */
export async function verifyUnknownImageServices(
  runtime: DockerRuntime,
  rows: ReadonlyArray<Pick<ServiceDeployment, "id" | "serviceId" | "containerId">>,
  services: ImageDriftService[],
  persist: (
    rowId: string,
    digest: string,
  ) => Promise<void> = (rowId, digest) =>
    repos.service.updateServiceDeployment(rowId, { imageDigest: digest }),
): Promise<void> {
  if (!runtime.supports("containerInfo")) return;
  for (const service of services) {
    const row = rows.find((candidate) => candidate.serviceId === service.serviceId);
    if (!row?.containerId) continue;
    const containerImageId = await withTimeout(
      runtime.getContainerInfo(row.containerId),
      CONTAINER_INSPECT_MS,
      "Container inspection timed out",
    )
      .then((info) => info.imageId ?? null)
      .catch((diagnosticFailure) => {
        observeCaughtError(
          diagnosticFailure,
          "platform/engine/modules/updates/local-image-drift",
        );
        return null;
      });
    // Local-only: `requirePresent` inspects the tag on this daemon and never
    // pulls a substitute. A tag the daemon does not have throws, and the
    // service stays unknown.
    const prepared = await withTimeout(
      runtime.prepareDeploymentImage(service.ref, { requirePresent: true }),
      TAG_RESOLVE_MS,
      "Local tag resolution timed out",
    ).catch((diagnosticFailure) => {
      observeCaughtError(
        diagnosticFailure,
        "platform/engine/modules/updates/local-image-drift",
      );
      return null;
    });
    const verdict = resolveUnknownDigestDrift({
      containerImageId,
      tagImageId: prepared?.imageId ?? null,
      tagRegistryDigest: prepared?.registryDigest ?? null,
      latestDigest: service.latestDigest,
    });
    if (verdict.behind) service.behind = true;
    if (!verdict.unknown) service.unknown = false;
    if (verdict.recoveredDigest) {
      service.deployedDigest = verdict.recoveredDigest;
      // Best-effort: a failed write must not fail the feed, and the verdict
      // above already stands on the local evidence.
      await persist(row.id, verdict.recoveredDigest).catch((diagnosticFailure) =>
        observeCaughtError(
          diagnosticFailure,
          "platform/engine/modules/updates/local-image-drift",
        ),
      );
    }
  }
}
