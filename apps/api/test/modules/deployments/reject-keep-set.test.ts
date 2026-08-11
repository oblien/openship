/**
 * D3: rejecting a deploy destroyed the release it had just restored.
 *
 * `rejectDeployment` restores the predecessor and then tears down the rejected
 * release's runtime — but a compose service that didn't change carries its
 * `containerId` and `imageRef` VERBATIM onto the next release's row (the
 * `carried` seam in compose/deploy.service.ts). So the rejected deployment's
 * manifest named the predecessor's LIVE container and the image the restore was
 * about to reuse, and `collectDeploymentManifest` consulted no keep set at all.
 *
 * The same shape breaks a plain delete and a build cancel: a cancelled deploy's
 * rows carry the live release's ids for every service it hadn't replaced yet.
 */

import { repos } from "@repo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the runtime resolution is faked — the keep set has to run against real
// rows or it isn't testing the query it exists for. `instanceof DockerRuntime`
// gates the image half of the manifest, so the stand-in must satisfy it.
vi.mock("../../../src/lib/deployment-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/deployment-runtime")>();
  const { DockerRuntime } = await import("@repo/adapters");
  return {
    ...actual,
    resolveDeploymentRuntime: async () => ({
      runtime: Object.create(DockerRuntime.prototype) as never,
    }),
  };
});

const { collectDeploymentManifest } = await import(
  "../../../src/modules/projects/project-cleanup.service"
);
const { computeCleanupKeepSet } = await import(
  "../../../src/modules/projects/cleanup-keep-set"
);

const {
  seedDeployment,
  seedOrg,
  seedProject,
  seedService,
  seedServiceDeployment,
  setActive,
} = await import("../../helpers/seed");

const CARRIED_CONTAINER = "carried-db-container";
const CARRIED_IMAGE = "openship/app-db:bld_old";
const OWN_CONTAINER = "rejected-web-container";
const OWN_IMAGE = "openship/app-web:bld_rejected";

describe("a rejected deploy's cleanup manifest", () => {
  let project: Awaited<ReturnType<typeof seedProject>>;
  let restored: Awaited<ReturnType<typeof seedDeployment>>;
  let rejected: Awaited<ReturnType<typeof seedDeployment>>;

  beforeEach(async () => {
    const org = await seedOrg();
    // Explicit window of 1 so the arithmetic is fixed: only the active release
    // plus one unpinned release is retained, and neither the instance default
    // nor a disk probe can move it.
    project = await seedProject(org.organizationId, {
      framework: "docker-compose",
      rollbackWindow: 1,
    });
    const db = await seedService(project.id, { name: "db", image: "postgres:16" });
    const web = await seedService(project.id, { name: "web", build: "." });

    restored = await seedDeployment(project, { containerId: "compose" });
    await seedServiceDeployment(restored.id, db, {
      containerId: CARRIED_CONTAINER,
      imageRef: CARRIED_IMAGE,
    });
    await seedServiceDeployment(restored.id, web, {
      containerId: "restored-web-container",
      imageRef: "openship/app-web:bld_restored",
    });

    rejected = await seedDeployment(project, {
      containerId: "compose",
      meta: { previousActiveDeploymentId: restored.id },
    });
    // `db` didn't change, so this release runs the SAME container and image the
    // restored release does — carried, not rebuilt.
    await seedServiceDeployment(rejected.id, db, {
      containerId: CARRIED_CONTAINER,
      imageRef: CARRIED_IMAGE,
    });
    await seedServiceDeployment(rejected.id, web, {
      containerId: OWN_CONTAINER,
      imageRef: OWN_IMAGE,
    });

    // The state reject actually runs in: the pointer still names the deployment
    // being rejected, because the restore only enqueues a deploy.
    await setActive(project.id, rejected.id);
    project = (await repos.project.findById(project.id))!;
  });

  it("excludes the carried container and the shared image", async () => {
    const manifest = await collectDeploymentManifest(rejected, project, {
      protectRetained: true,
      alsoProtectDeploymentId: restored.id,
    });
    const refs = manifest.resources.map((r) => r.ref);

    expect(refs).not.toContain(CARRIED_CONTAINER);
    expect(refs).not.toContain(CARRIED_IMAGE);
    // Its own artifacts still go — reject means this release stops existing at
    // runtime, so protecting everything would just leak.
    expect(refs).toContain(OWN_CONTAINER);
    expect(refs).toContain(OWN_IMAGE);
  });

  it("would have destroyed them without the flag", async () => {
    // Guards the fix itself: if the keep set stopped being consulted this passes
    // while the test above fails, which is the pair that pins the behavior.
    const manifest = await collectDeploymentManifest(rejected, project, {
      protectRetained: false,
    });
    const refs = manifest.resources.map((r) => r.ref);
    expect(refs).toContain(CARRIED_CONTAINER);
    expect(refs).toContain(CARRIED_IMAGE);
  });

  it("protects the live release on a plain delete, with no predecessor hint", async () => {
    // Deleting an OLD release: the active one is unambiguous, so the keep set
    // needs no help to see that the old row names a container still running.
    await setActive(project.id, restored.id);
    const live = (await repos.project.findById(project.id))!;

    const manifest = await collectDeploymentManifest(rejected, live, {
      protectRetained: true,
    });
    const refs = manifest.resources.map((r) => r.ref);
    expect(refs).not.toContain(CARRIED_CONTAINER);
    expect(refs).not.toContain(CARRIED_IMAGE);
    expect(refs).toContain(OWN_CONTAINER);
  });

  it("never lists the compose sentinel as a container", async () => {
    // `containerId: "compose"` is a marker meaning "this release's containers
    // live on the service rows"; destroying it would be a bogus docker call.
    const manifest = await collectDeploymentManifest(rejected, project, {
      protectRetained: true,
      alsoProtectDeploymentId: restored.id,
    });
    expect(manifest.resources.filter((r) => r.type === "container").map((r) => r.ref)).not.toContain(
      "compose",
    );
  });
});

describe("computeCleanupKeepSet", () => {
  it("keeps the restored release even when the active pointer still names the rejected one", async () => {
    const org = await seedOrg();
    const project = await seedProject(org.organizationId, { rollbackWindow: 1 });
    const svc = await seedService(project.id, { name: "web", build: "." });

    const restored = await seedDeployment(project, { containerId: "restored-container" });
    await seedServiceDeployment(restored.id, svc, {
      containerId: "restored-container",
      imageRef: "openship/app:bld_restored",
    });
    const rejected = await seedDeployment(project, { containerId: "rejected-container" });
    await seedServiceDeployment(rejected.id, svc, {
      containerId: "rejected-container",
      imageRef: "openship/app:bld_rejected",
    });
    await setActive(project.id, rejected.id);
    const live = (await repos.project.findById(project.id))!;

    const keep = await computeCleanupKeepSet(live, {
      excludeDeploymentId: rejected.id,
      alsoProtectDeploymentId: restored.id,
    });

    expect(keep.containers.has("restored-container")).toBe(true);
    expect(keep.images.has("openship/app:bld_restored")).toBe(true);
    // The excluded release must not keep itself alive, or a reject leaks every
    // image it built.
    expect(keep.containers.has("rejected-container")).toBe(false);
    expect(keep.images.has("openship/app:bld_rejected")).toBe(false);
  });

  it("protects a release that never reached ready", async () => {
    // A partial-failure deploy is rejectable, and its predecessor can sit
    // outside the ready list computeKeepSet walks — so the explicitly protected
    // release is unioned in by id rather than looked up in that list.
    const org = await seedOrg();
    const project = await seedProject(org.organizationId, { rollbackWindow: 1 });
    const svc = await seedService(project.id, { name: "web", build: "." });

    const predecessor = await seedDeployment(project, {
      status: "partial_failure",
      containerId: "partial-container",
      imageRef: "openship/app:bld_partial",
    });
    await seedServiceDeployment(predecessor.id, svc, {
      containerId: "partial-container",
      imageRef: "openship/app:bld_partial",
    });
    const rejected = await seedDeployment(project);
    await setActive(project.id, rejected.id);
    const live = (await repos.project.findById(project.id))!;

    const keep = await computeCleanupKeepSet(live, {
      excludeDeploymentId: rejected.id,
      alsoProtectDeploymentId: predecessor.id,
    });
    expect(keep.containers.has("partial-container")).toBe(true);
    expect(keep.images.has("openship/app:bld_partial")).toBe(true);
  });
});
