import type { RuntimeImageCheckResult, UpdateRuntimeInput } from "@repo/contracts";
import {
  digestSha,
  isMutableImageRef,
  renderReleaseImage,
  ValidationError,
  withTimeout,
} from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { findActiveDeployment } from "../../lib/active-deployment";
import { parseImageRef, resolveLatestImageDigest } from "../../lib/image-registry";
import { mapWithLimit } from "../../lib/map-with-limit";
import { assertResourceInOrg } from "../../lib/resource-access";
import { readRuntimeImageReceipts } from "../../lib/runtime-image-receipts";
import { buildConfigSnapshot } from "../deployments/build.service";
import { assertServiceTargetMembership } from "../deployments/exact-service-targets";

type Image = RuntimeImageCheckResult["images"][number];
const validDigest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);

/** Compare immutable build receipts and deployed images with the shared registry resolver. */
export async function getProjectRuntimeImages(
  ctx: ExecutionContext,
  projectId: string,
  input: UpdateRuntimeInput = {},
): Promise<RuntimeImageCheckResult> {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  const [active, services] = await Promise.all([
    findActiveDeployment(project),
    repos.service.listByProject(projectId),
  ]);
  if (input.serviceIds) {
    try {
      assertServiceTargetMembership(services, input.serviceIds, "Image update check");
    } catch (error) {
      throw new ValidationError((error as Error).message);
    }
  }
  const selected = services.filter(
    (service) => service.enabled && (!input.serviceIds || input.serviceIds.includes(service.id)),
  );
  const meta = (active?.meta ?? {}) as Record<string, unknown>;
  const captured = readRuntimeImageReceipts(meta.runtimeImages);
  const rows = active ? await repos.service.listByDeployment(active.id) : [];
  const images: Image[] = [];
  const add = (
    serviceId: string | null,
    serviceName: string | null,
    role: Image["role"],
    ref: string,
    digest?: string | null,
  ) => {
    if (
      !ref.trim() ||
      images.some(
        (image) => image.serviceId === serviceId && image.role === role && image.ref === ref,
      )
    )
      return;
    const pinned = !isMutableImageRef(ref);
    const normalizedDigest = digestSha(digest ?? undefined);
    images.push({
      serviceId,
      serviceName,
      role,
      ref,
      currentDigest: validDigest(normalizedDigest) ? normalizedDigest : null,
      latestDigest: null,
      status: pinned ? "pinned" : "unknown",
    });
  };

  for (const service of selected) {
    const observed = rows.find((row) => row.serviceId === service.id);
    if (service.image && !service.build && !service.dockerfile) {
      // A changed configured reference has no deployed baseline for that tag.
      add(
        service.id,
        service.name,
        "image",
        service.image,
        observed?.imageRef === service.image ||
          ((meta as { composeServices?: Array<{ name: string; image?: string }> }).composeServices?.some((item) => item.name === service.name && item.image === service.image) &&
            (meta as { handoverImages?: Record<string, string> }).handoverImages?.[service.name] === observed?.imageRef)
          ? (observed?.imageRef?.includes("@sha256:") ? observed.imageRef.split("@")[1] : observed?.imageDigest) : null,
      );
    }
    const bases =
      observed?.status === "success" &&
      observed.imageRef === captured.artifacts?.services?.[service.id]
        ? (captured.services?.[service.id] ?? [])
        : [];
    for (const base of bases) add(service.id, service.name, "base", base.ref, base.digest);
    if (!bases.length && (service.build || service.dockerfile || service.kind === "monorepo")) {
      // Old releases do not have receipts. A registry result alone cannot prove
      // which base BuildKit used, so the answer stays unknown until a fresh build.
      for (const ref of [service.buildImage, project.buildImage])
        if (ref) add(service.id, service.name, "base", ref);
    }
  }
  if (!input.serviceIds) {
    const bases =
      active?.imageRef && active.imageRef === captured.artifacts?.app ? (captured.app ?? []) : [];
    for (const base of bases) add(null, null, "base", base.ref, base.digest);
    if (!bases.length && !selected.length) {
      const snapshot = buildConfigSnapshot(project);
      if (
        snapshot.build === "buildpack" ||
        snapshot.build === "dockerfile" ||
        snapshot.build === "static"
      ) {
        for (const ref of [snapshot.buildImage, snapshot.runtimeImage])
          if (ref) add(null, null, "base", ref);
      }
    }
    if (typeof meta.releaseImageRef === "string") {
      let ref =
        typeof meta.runtimeImageSource === "string"
          ? meta.runtimeImageSource
          : meta.releaseImageRef;
      const version =
        typeof meta.releaseVersion === "string" ? meta.releaseVersion : active?.releaseVersion;
      const tag = typeof meta.releaseTag === "string" ? meta.releaseTag : version;
      if (!meta.runtimeImageSource && project.releaseSource?.imageTemplate && version && tag) {
        ref = renderReleaseImage(project.releaseSource.imageTemplate, { version, tag });
      }
      const frozen = parseImageRef(meta.releaseImageRef),
        configured = parseImageRef(ref);
      const sameRepository =
        frozen?.registry === configured?.registry && frozen?.repo === configured?.repo;
      add(null, null, "image", ref, sameRepository ? digestSha(meta.releaseImageRef) : null);
    }
  }

  return { checkedAt: new Date().toISOString(), images };
}

export async function checkProjectRuntimeImages(
  ctx: ExecutionContext,
  projectId: string,
  input: UpdateRuntimeInput = {},
): Promise<RuntimeImageCheckResult> {
  const { images } = await getProjectRuntimeImages(ctx, projectId, input);
  const deadline = Date.now() + 12_000;
  const byRef = new Map<string, Promise<string | null>>();
  await withTimeout(
    mapWithLimit(
      images.filter((image) => image.status !== "pinned"),
      6,
      async (image) => {
        if (Date.now() >= deadline) return;
        let pending = byRef.get(image.ref);
        if (!pending) {
          pending = resolveLatestImageDigest(image.ref, { refresh: true });
          byRef.set(image.ref, pending);
        }
        const latest = await pending;
        if (Date.now() >= deadline) return;
        image.latestDigest = validDigest(latest) ? latest : null;
        image.status =
          image.currentDigest && image.latestDigest
            ? image.currentDigest === image.latestDigest
              ? "current"
              : "update_available"
            : "unknown";
      },
    ),
    12_000,
    "Runtime image check timed out",
  ).catch((error) => {
    reportCaughtError(error, "platform/engine/modules/updates/runtime-image-check");
  });

  return {
    checkedAt: new Date().toISOString(),
    images,
  };
}
