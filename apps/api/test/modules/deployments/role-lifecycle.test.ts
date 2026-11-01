/**
 * Runtime role containers follow their release through every lifecycle path
 * outside the deploy: pause, resume and restart (deploymentContainerIds),
 * teardown (collectDeploymentManifest) and protection (computeCleanupKeepSet).
 *
 * Real rows through the seed helpers; only runtime resolution is faked, as in
 * reject-keep-set.test.ts.
 */

import { repos } from "@repo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/platform/engine/lib/deployment-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@repo/platform/engine/lib/deployment-runtime")>();
  const { DockerRuntime } = await import("@repo/adapters");
  return {
    ...actual,
    resolveDeploymentRuntime: async () => ({
      runtime: Object.create(DockerRuntime.prototype) as never,
    }),
  };
});

const { deploymentContainerIds } = await import("@repo/platform/engine/lib/deployment-runtime");
const { collectDeploymentManifest } =
  await import("@repo/platform/engine/modules/projects/project-cleanup.service");
const { computeCleanupKeepSet } =
  await import("@repo/platform/engine/modules/projects/cleanup-keep-set");
const { seedDeployment, seedOrg, seedProject, seedService, seedServiceDeployment, setActive } =
  await import("../../helpers/seed");

const roleRefs = [
  { role: "worker", replica: 1, containerId: "role-worker-1" },
  { role: "sched", replica: 1, containerId: "role-sched-1" },
];

describe("deploymentContainerIds with role containers", () => {
  let project: Awaited<ReturnType<typeof seedProject>>;

  beforeEach(async () => {
    const org = await seedOrg();
    project = await seedProject(org.organizationId);
  });

  it("lists the web container first, then the roles in recorded order", async () => {
    const dep = await seedDeployment(project, { containerId: "web-1" });
    await repos.deployment.setRoleContainers(dep.id, roleRefs);
    const row = (await repos.deployment.findById(dep.id))!;
    expect(await deploymentContainerIds(row)).toEqual(["web-1", "role-worker-1", "role-sched-1"]);
  });

  it("is unchanged without roles", async () => {
    const dep = await seedDeployment(project, { containerId: "web-1" });
    expect(await deploymentContainerIds(dep)).toEqual(["web-1"]);
    await repos.deployment.setRoleContainers(dep.id, []);
    const row = (await repos.deployment.findById(dep.id))!;
    expect(await deploymentContainerIds(row)).toEqual(["web-1"]);
  });

  it("lists a duplicate id once", async () => {
    const dep = await seedDeployment(project, { containerId: "web-1" });
    await repos.deployment.setRoleContainers(dep.id, [
      { role: "worker", replica: 1, containerId: "web-1" },
      { role: "worker", replica: 2, containerId: "role-worker-2" },
      { role: "worker", replica: 3, containerId: "role-worker-2" },
    ]);
    const row = (await repos.deployment.findById(dep.id))!;
    expect(await deploymentContainerIds(row)).toEqual(["web-1", "role-worker-2"]);
  });

  it("puts role ids after the service ids", async () => {
    const dep = await seedDeployment(project, { containerId: "compose" });
    const web = await seedService(project.id, { name: "web", build: "." });
    const db = await seedService(project.id, { name: "db", image: "postgres:16" });
    await seedServiceDeployment(dep.id, web, { containerId: "svc-web" });
    await seedServiceDeployment(dep.id, db, { containerId: "svc-db" });
    await repos.deployment.setRoleContainers(dep.id, roleRefs);
    const row = (await repos.deployment.findById(dep.id))!;
    const ids = await deploymentContainerIds(row);
    expect(ids.slice(-2)).toEqual(["role-worker-1", "role-sched-1"]);
    expect(ids).toHaveLength(4);
    expect(ids).not.toContain("compose");
  });
});

describe("collectDeploymentManifest with role containers", () => {
  let project: Awaited<ReturnType<typeof seedProject>>;
  let live: Awaited<ReturnType<typeof seedDeployment>>;
  let target: Awaited<ReturnType<typeof seedDeployment>>;

  beforeEach(async () => {
    const org = await seedOrg();
    project = await seedProject(org.organizationId, { rollbackWindow: 1 });
    live = await seedDeployment(project, { containerId: "live-web" });
    await repos.deployment.setRoleContainers(live.id, [
      { role: "worker", replica: 1, containerId: "live-worker-1" },
    ]);
    target = await seedDeployment(project, { containerId: "target-web" });
    await repos.deployment.setRoleContainers(target.id, roleRefs);
    await setActive(project.id, live.id);
    project = (await repos.project.findById(project.id))!;
    live = (await repos.deployment.findById(live.id))!;
    target = (await repos.deployment.findById(target.id))!;
  });

  it("lists a deployment's role containers as container resources", async () => {
    const manifest = await collectDeploymentManifest(target, project, { protectRetained: true });
    const containers = manifest.resources.filter((r) => r.type === "container").map((r) => r.ref);
    expect(containers).toEqual(
      expect.arrayContaining(["target-web", "role-worker-1", "role-sched-1"]),
    );
  });

  it("skips a role container that is in the keep set", async () => {
    // The live release's worker is carried onto the target's record by mistake.
    await repos.deployment.setRoleContainers(target.id, [
      ...roleRefs,
      { role: "worker", replica: 2, containerId: "live-worker-1" },
    ]);
    target = (await repos.deployment.findById(target.id))!;
    const manifest = await collectDeploymentManifest(target, project, { protectRetained: true });
    const refs = manifest.resources.map((r) => r.ref);
    expect(refs).not.toContain("live-worker-1");
    expect(refs).toContain("role-worker-1");
  });

  it("lists each role container once", async () => {
    await repos.deployment.setRoleContainers(target.id, [
      ...roleRefs,
      { role: "worker", replica: 2, containerId: "role-worker-1" },
    ]);
    target = (await repos.deployment.findById(target.id))!;
    const manifest = await collectDeploymentManifest(target, project, { protectRetained: true });
    expect(manifest.resources.filter((r) => r.ref === "role-worker-1")).toHaveLength(1);
  });
});

describe("computeCleanupKeepSet with role containers", () => {
  it("protects the live release's role containers and not the excluded one's", async () => {
    const org = await seedOrg();
    let project = await seedProject(org.organizationId, { rollbackWindow: 1 });
    const live = await seedDeployment(project, { containerId: "live-web" });
    await repos.deployment.setRoleContainers(live.id, [
      { role: "worker", replica: 1, containerId: "live-worker-1" },
      { role: "sched", replica: 1, containerId: "live-sched-1" },
    ]);
    const excluded = await seedDeployment(project, { containerId: "excluded-web" });
    await repos.deployment.setRoleContainers(excluded.id, roleRefs);
    await setActive(project.id, live.id);
    project = (await repos.project.findById(project.id))!;

    const keep = await computeCleanupKeepSet(project, { excludeDeploymentId: excluded.id });
    expect(keep.containers).toEqual(new Set(["live-web", "live-worker-1", "live-sched-1"]));
    expect(keep.containers.has("role-worker-1")).toBe(false);
  });
});
