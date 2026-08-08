/**
 * D3 follow-on: a failed compose redeploy destroyed carried-forward containers.
 *
 * `onFailure` tears down a failed release's runtime — but a compose service that
 * didn't change carries its `containerId` and `imageRef` verbatim onto the failed
 * release's row (the `carried` seam in compose/deploy.service.ts). The old path
 * called `runtime.destroy` on every service row, so a deploy that carried `db`
 * forward and then failed on `web` took down the live `db` container while
 * `activeDeploymentId` still named the previous release.
 *
 * The fix mirrors reject/delete/cancel: consult `collectDeploymentManifest` with
 * `protectRetained: true` so the live release's artifacts survive.
 */

import { repos } from "@repo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const {
  seedDeployment,
  seedOrg,
  seedProject,
  seedService,
  seedServiceDeployment,
  setActive,
} = await import("../../helpers/seed");

const CARRIED_CONTAINER = "carried-db-container";
const CARRIED_IMAGE = "openship/app-db:bld_live";
const OWN_CONTAINER = "failed-web-container";
const OWN_IMAGE = "openship/app-web:bld_failed";

describe("a failed deploy's cleanup manifest", () => {
  let project: Awaited<ReturnType<typeof seedProject>>;
  let live: Awaited<ReturnType<typeof seedDeployment>>;
  let failed: Awaited<ReturnType<typeof seedDeployment>>;

  beforeEach(async () => {
    const org = await seedOrg();
    project = await seedProject(org.organizationId, {
      framework: "docker-compose",
      rollbackWindow: 1,
    });
    const db = await seedService(project.id, { name: "db", image: "postgres:16" });
    const web = await seedService(project.id, { name: "web", build: "." });

    live = await seedDeployment(project, { containerId: "compose", status: "ready" });
    await seedServiceDeployment(live.id, db, {
      containerId: CARRIED_CONTAINER,
      imageRef: CARRIED_IMAGE,
    });
    await seedServiceDeployment(live.id, web, {
      containerId: "live-web-container",
      imageRef: "openship/app-web:bld_live",
    });

    failed = await seedDeployment(project, { containerId: "compose", status: "deploying" });
    await seedServiceDeployment(failed.id, db, {
      containerId: CARRIED_CONTAINER,
      imageRef: CARRIED_IMAGE,
    });
    await seedServiceDeployment(failed.id, web, {
      containerId: OWN_CONTAINER,
      imageRef: OWN_IMAGE,
    });

    // onFailure never advances the pointer — the live release stays active.
    await setActive(project.id, live.id);
    project = (await repos.project.findById(project.id))!;
  });

  it("excludes the carried container and the shared image", async () => {
    const manifest = await collectDeploymentManifest(failed, project, {
      protectRetained: true,
    });
    const refs = manifest.resources.map((r) => r.ref);

    expect(refs).not.toContain(CARRIED_CONTAINER);
    expect(refs).not.toContain(CARRIED_IMAGE);
    expect(refs).toContain(OWN_CONTAINER);
    expect(refs).toContain(OWN_IMAGE);
  });

  it("would have destroyed them without the flag", async () => {
    const manifest = await collectDeploymentManifest(failed, project, {
      protectRetained: false,
    });
    const refs = manifest.resources.map((r) => r.ref);
    expect(refs).toContain(CARRIED_CONTAINER);
    expect(refs).toContain(CARRIED_IMAGE);
  });

  it("never lists the compose sentinel as a container", async () => {
    const manifest = await collectDeploymentManifest(failed, project, {
      protectRetained: true,
    });
    expect(manifest.resources.filter((r) => r.type === "container").map((r) => r.ref)).not.toContain(
      "compose",
    );
  });
});
