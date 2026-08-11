/**
 * D2: a rollback deleted every service added after the release it restored.
 *
 * `build-pipeline` hands `syncFromCompose` the TARGET release's frozen service
 * list, and the sync hard-deleted any compose row missing from that list. Since
 * `service_deployment.serviceId` is ON DELETE CASCADE, one rollback erased the
 * service's row AND its deploy history across every release — while its
 * container kept running, now owned by nothing.
 *
 * The same delete broke NORMAL deploys too: `deployComposeServices` builds its
 * de-listed-container reaper input from the active deployment's
 * `service_deployment` rows, and the sync runs first. So a service genuinely
 * removed from a compose file had its rows cascaded away before the reaper could
 * read them, and its container was orphaned rather than stopped.
 *
 * Locked decision: a rollback leaves services newer than the target running and
 * untouched — no row deleted, no history cascaded, and (see the second describe)
 * no rebuild or recreate either.
 */

import { repos } from "@repo/db";
import { beforeEach, describe, expect, it } from "vitest";

import { newerThanRestoredRelease } from "../../../src/modules/deployments/compose/project-services";
import {
  seedDeployment,
  seedOrg,
  seedProject,
  seedService,
  seedServiceDeployment,
} from "../../helpers/seed";

describe("a rollback preserves services added after the target release", () => {
  let projectId: string;
  let organizationId: string;

  beforeEach(async () => {
    const org = await seedOrg();
    organizationId = org.organizationId;
    const project = await seedProject(organizationId, { framework: "docker-compose" });
    projectId = project.id;
  });

  it("keeps the row, its history, and its container reference", async () => {
    const web = await seedService(projectId, { name: "web", image: "nginx" });
    // Added after the release we're about to roll back to.
    const cache = await seedService(projectId, { name: "cache", image: "redis:7" });

    const dep = await seedDeployment({ id: projectId, organizationId });
    await seedServiceDeployment(dep.id, web, { containerId: "web-container" });
    const cacheRun = await seedServiceDeployment(dep.id, cache, {
      containerId: "cache-container",
    });

    // What the rollback replays: the frozen list, which predates `cache`.
    await repos.service.syncFromCompose(
      projectId,
      [{ name: "web", image: "nginx", ports: [], dependsOn: [], environment: {}, volumes: [] }],
      { removeMissing: false },
    );

    expect(await repos.service.findById(cache.id)).toBeTruthy();
    const history = await repos.service.listByDeployment(dep.id);
    expect(history.map((r) => r.serviceName).sort()).toEqual(["cache", "web"]);
    expect(history.find((r) => r.id === cacheRun.id)?.containerId).toBe("cache-container");
  });

  it("leaves the reaper its input on a normal deploy that drops a service", async () => {
    // The reaper stops containers whose service is no longer enabled, and it
    // reads the ACTIVE deployment's service_deployment rows. Cascading them away
    // during the sync is what orphaned the container.
    const web = await seedService(projectId, { name: "web", image: "nginx" });
    const dropped = await seedService(projectId, { name: "legacy", image: "busybox" });

    const active = await seedDeployment({ id: projectId, organizationId });
    await seedServiceDeployment(active.id, web, { containerId: "web-container" });
    await seedServiceDeployment(active.id, dropped, { containerId: "legacy-container" });

    await repos.service.syncFromCompose(
      projectId,
      [{ name: "web", image: "nginx", ports: [], dependsOn: [], environment: {}, volumes: [] }],
      { removeMissing: false },
    );

    const reaperInput = await repos.service.listByDeployment(active.id);
    expect(reaperInput.find((r) => r.serviceName === "legacy")?.containerId).toBe(
      "legacy-container",
    );
  });

  it("still removes de-listed rows when a caller asks for it", async () => {
    // The explicit reconcile / project-config paths keep the old behavior: the
    // default is unchanged, so only the two deploy sites opted out.
    const gone = await seedService(projectId, { name: "gone", image: "busybox" });

    await repos.service.syncFromCompose(projectId, [
      { name: "web", image: "nginx", ports: [], dependsOn: [], environment: {}, volumes: [] },
    ]);

    expect(await repos.service.findById(gone.id)).toBeFalsy();
  });
});

describe("newerThanRestoredRelease", () => {
  const frozen = { composeServices: [{ name: "web" }, { name: "db" }] };

  it("flags a service the restored release never had", () => {
    const isNewer = newerThanRestoredRelease({ trigger: "rollback", meta: frozen });
    expect(isNewer({ name: "cache" })).toBe(true);
    expect(isNewer({ name: "web" })).toBe(false);
  });

  it("flags nothing when the deploy is not a rollback", () => {
    // A normal deploy's snapshot is authoritative; skipping services here would
    // silently stop deploying whatever the compose file dropped.
    const isNewer = newerThanRestoredRelease({ trigger: "push", meta: frozen });
    expect(isNewer({ name: "cache" })).toBe(false);
  });

  it("flags nothing when the release recorded no service list", () => {
    // Otherwise every service would be "newer" and the rollback would be a
    // silent no-op that reports success.
    expect(newerThanRestoredRelease({ trigger: "rollback", meta: {} })({ name: "web" })).toBe(
      false,
    );
    expect(newerThanRestoredRelease({ trigger: "rollback", meta: null })({ name: "web" })).toBe(
      false,
    );
    expect(
      newerThanRestoredRelease({ trigger: "rollback", meta: { composeServices: [] } })({
        name: "web",
      }),
    ).toBe(false);
  });
});
