/** Real database + real Docker artifacts, driven through the production
 * retention entry points. The only substituted seam locates the test daemon. */
import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRuntime } from "@repo/adapters";
import { repos, type Deployment } from "@repo/db";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { seedOrg, seedProject, seedDeployment, seedService, seedServiceDeployment, setActive } from "../helpers/seed";

const h = vi.hoisted(() => ({ runtime: null as DockerRuntime | null }));
vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...await original<typeof import("@repo/platform/engine/lib/deployment-runtime")>(),
  resolveDeploymentRuntime: async () => ({ runtime: h.runtime!, serverId: null }),
}));

import { onDeploymentReady, setPin, reconcileProjectRetention } from "@repo/platform/engine/modules/deployments/rollback/rollback-orchestrator";
import { reconcileDeployment } from "@repo/platform/engine/modules/deployments/reconcile.service";
import { runImageGcSweep } from "@repo/platform/engine/modules/deployments/image-gc";
import { updateProject } from "@repo/platform/engine/modules/projects/project-crud.service";

describeDockerE2E("rollback retention matches rows and real artifacts", () => {
  let runtime: DockerRuntime;
  let contextDir: string;
  let sequence = 0;
  const cleanupTags = new Set<string>();
  const cleanupContainers = new Set<string>();
  const BASE_IMAGE = "busybox:1.37.0";

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    h.runtime = runtime;
    await runtime.pullImage(BASE_IMAGE);
    contextDir = await mkdtemp(join(tmpdir(), "openship-retention-e2e-"));
    await writeFile(join(contextDir, "Dockerfile"), `FROM ${BASE_IMAGE}\nCMD ["sleep", "3600"]\n`);
    await repos.instanceSettings.upsert({ defaultRollbackWindow: 5 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of cleanupContainers) await runtime.destroy(id);
    cleanupContainers.clear();
    for (const tag of cleanupTags) await runtime.removeImage(tag);
    cleanupTags.clear();
  });
  afterAll(async () => {
    await runtime?.dispose();
    if (contextDir) await rm(contextDir, { recursive: true, force: true });
  });

  async function image(projectId: string, tag: string) {
    cleanupTags.add(tag);
    const stream = await runtime.docker.buildImage(
      { context: contextDir, src: ["Dockerfile"] },
      { t: tag, labels: { "openship.project": projectId, "retention-test": tag } },
    );
    await new Promise<void>((resolve, reject) => runtime.docker.modem.followProgress(stream,
      (err: Error | null) => err ? reject(err) : resolve()));
  }

  async function container(projectId: string, tag: string) {
    const created = await runtime.docker.createContainer({
      Image: tag, Cmd: ["sleep", "3600"], Labels: { "openship.project": projectId },
      StopTimeout: 1,
    });
    cleanupContainers.add(created.id);
    await created.start();
    return created.id;
  }

  async function fixture(options: { count?: number; compose?: boolean; pinned?: boolean } = {}) {
    const org = await seedOrg();
    const project = await seedProject(org.organizationId, { rollbackWindow: null, rollbackWindowComputed: 20, runtimeMode: "docker" });
    const repository = `openship/e2e-retention-${process.pid}-${sequence++}`;
    const tags = Array.from({ length: options.count ?? 9 }, (_, index) => `${repository}:bld_v${index}`);
    // Multiple releases legitimately share layers/an image ID. Old tags must
    // still disappear while a retained tag and its live container survive.
    await image(project.id, tags[0]!);
    for (let index = 1; index < tags.length; index += 1) {
      cleanupTags.add(tags[index]!);
      await runtime.docker.getImage(tags[0]!).tag({ repo: repository, tag: `bld_v${index}` });
    }
    const activeContainer = await container(project.id, tags.at(-1)!);
    const workerContainer = options.compose ? await container(project.id, tags[0]!) : null;
    const web = options.compose ? await seedService(project.id, { name: "web" }) : null;
    const worker = options.compose ? await seedService(project.id, { name: "worker" }) : null;
    const rows: Deployment[] = [];
    for (let index = 0; index < tags.length; index += 1) {
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, index));
      const row = await seedDeployment(project, {
        imageRef: options.compose ? "compose" : tags[index],
        containerId: options.compose ? "compose" : index === tags.length - 1 ? activeContainer : null,
        artifactRetainedAt: new Date(),
        pinned: options.pinned && index === 0,
        // Old partial releases used to escape pruning forever.
        status: index === 1 ? "partial_failure" : "ready",
        createdAt,
        meta: { deployTarget: "local", runtimeMode: "docker" },
      });
      rows.push(row);
      if (web && worker) {
        await seedServiceDeployment(row.id, web, {
          imageRef: tags[index], containerId: index === tags.length - 1 ? activeContainer : null, createdAt,
        });
        await seedServiceDeployment(row.id, worker, {
          imageRef: index === 0 ? tags[0] : null,
          containerId: workerContainer,
          status: index === 0 ? "success" : "skipped",
          createdAt,
        });
      }
    }
    await setActive(project.id, rows.at(-1)!.id);
    return { project, rows, tags, activeContainer, workerContainer };
  }

  async function snapshots(projectId: string) {
    const project = (await repos.project.findById(projectId))!;
    return (await repos.deployment.listForRetention(projectId))
      .filter((row) => row.id !== project.activeDeploymentId && !row.pinned && row.artifactRetainedAt);
  }

  it("keeps exactly five past snapshots after a deploy and removes expired tags", async () => {
    const f = await fixture();
    await onDeploymentReady({ newDeployment: f.rows.at(-1)!, previousActive: f.rows.at(-2)! });
    expect(await snapshots(f.project.id)).toHaveLength(5);
    for (let index = 0; index < f.tags.length; index += 1) {
      const kept = index >= f.tags.length - 6;
      expect(Boolean((await repos.deployment.findById(f.rows[index]!.id))!.artifactRetainedAt)).toBe(kept);
      expect(await runtime.imageExistsLocally(f.tags[index]!)).toBe(kept);
    }
    expect((await runtime.docker.getContainer(f.activeContainer).inspect()).State.Running).toBe(true);
    expect(await runtime.imageExistsLocally(BASE_IMAGE)).toBe(true);
    expect((await repos.deployment.listByProject(f.project.id)).total).toBe(9);
  });

  it("enforces a saved limit immediately and reclaims an old pin when unpinned", async () => {
    const f = await fixture({ pinned: true });
    await updateProject(f.project.id, { rollbackWindow: 2 }, f.project.organizationId);
    expect(await snapshots(f.project.id)).toHaveLength(2);
    expect(await runtime.imageExistsLocally(f.tags[0]!)).toBe(true);
    await setPin(f.rows[0]!.id, false);
    expect((await repos.deployment.findById(f.rows[0]!.id))!.artifactRetainedAt).toBeNull();
    expect(await runtime.imageExistsLocally(f.tags[0]!)).toBe(false);
    expect(await snapshots(f.project.id)).toHaveLength(2);
  });

  it("counts multi-service releases once and protects carried images and live containers", async () => {
    const f = await fixture({ compose: true });
    await reconcileProjectRetention(f.project.id);
    expect(await snapshots(f.project.id)).toHaveLength(5);
    expect((await repos.deployment.findById(f.rows[0]!.id))!.artifactRetainedAt).toBeNull();
    expect(await runtime.imageExistsLocally(f.tags[0]!)).toBe(true); // carried worker
    expect(await runtime.imageExistsLocally(f.tags[1]!)).toBe(false); // expired partial release
    expect((await runtime.docker.getContainer(f.workerContainer!).inspect()).State.Running).toBe(true);
    await updateProject(f.project.id, { rollbackWindow: 0 }, f.project.organizationId);
    expect(await snapshots(f.project.id)).toHaveLength(0);
    expect(await runtime.imageExistsLocally(f.tags[0]!)).toBe(true);
    expect(await runtime.imageExistsLocally(f.tags.at(-1)!)).toBe(true);
    expect((await runtime.docker.getContainer(f.activeContainer).inspect()).State.Running).toBe(true);
    expect((await runtime.docker.getContainer(f.workerContainer!).inspect()).State.Running).toBe(true);
  });

  it("retries failed reclamation through the scheduled sweep before clearing the row", async () => {
    const f = await fixture();
    const remove = runtime.removeImage.bind(runtime);
    vi.spyOn(runtime, "removeImage").mockImplementation(async (ref) => {
      if (ref === f.tags[1]) throw new Error("temporary image removal failure");
      await remove(ref);
    });
    expect((await reconcileProjectRetention(f.project.id)).errors).toBe(1);
    expect((await repos.deployment.findById(f.rows[1]!.id))!.artifactRetainedAt).not.toBeNull();
    expect(await runtime.imageExistsLocally(f.tags[1]!)).toBe(true);
    vi.restoreAllMocks();
    expect((await runImageGcSweep()).errors).toBe(0);
    expect((await repos.deployment.findById(f.rows[1]!.id))!.artifactRetainedAt).toBeNull();
    expect(await runtime.imageExistsLocally(f.tags[1]!)).toBe(false);
  });

  it("defers cleanup until a cancelled worker has actually finished", async () => {
    const f = await fixture();
    const cancelled = await seedDeployment(f.project, { status: "cancelled" });
    const session = await repos.deployment.createBuildSession({
      projectId: f.project.id, deploymentId: cancelled.id, status: "cancelled", startedAt: new Date(),
    });
    await updateProject(f.project.id, { rollbackWindow: 1 }, f.project.organizationId);
    expect(await snapshots(f.project.id)).toHaveLength(8);
    expect(await runtime.imageExistsLocally(f.tags[0]!)).toBe(true);
    await repos.deployment.updateBuildSession(session.id, { finishedAt: new Date() });
    await reconcileProjectRetention(f.project.id);
    expect(await snapshots(f.project.id)).toHaveLength(1);
    expect(await runtime.imageExistsLocally(f.tags[0]!)).toBe(false);
  });

  it("does not force-remove an unrecorded container's image", async () => {
    const f = await fixture({ count: 2 });
    const orphan = `openship/e2e-retention-orphan-${process.pid}-${sequence++}:bld_old`;
    await image(f.project.id, orphan);
    const id = await container(f.project.id, orphan);
    // No deployment row names this manually created container. Docker itself
    // must refuse removal; force=true would silently untag its only image.
    const result = await reconcileProjectRetention(f.project.id);
    expect(result.skippedInUse).toBeGreaterThan(0);
    expect(await runtime.imageExistsLocally(orphan)).toBe(true);
    expect((await runtime.docker.getContainer(id).inspect()).State.Running).toBe(true);
    await runtime.destroy(id);
    cleanupContainers.delete(id);
    await reconcileProjectRetention(f.project.id);
    expect(await runtime.imageExistsLocally(orphan)).toBe(false);
  });

  it("protects an unverified release and applies retention after host verification", async () => {
    const f = await fixture();
    const target = f.rows.at(-1)!;
    await setActive(f.project.id, f.rows.at(-2)!.id);
    await repos.deployment.updateStatus(target.id, "reconciling");
    await repos.deployment.setArtifactRetainedAt(target.id, null);
    await updateProject(f.project.id, { rollbackWindow: 1 }, f.project.organizationId);
    // Same image ID as the active release: Docker allows untagging, so the
    // database keep-set itself must protect this not-yet-verified tag.
    expect(await runtime.imageExistsLocally(f.tags.at(-1)!)).toBe(true);
    expect(await reconcileDeployment(target.id)).toBe("finalized");
    expect((await repos.project.findById(f.project.id))!.activeDeploymentId).toBe(target.id);
    expect((await repos.deployment.findById(target.id))!.artifactRetainedAt).not.toBeNull();
    expect(await snapshots(f.project.id)).toHaveLength(1);
    expect(await runtime.imageExistsLocally(f.tags.at(-3)!)).toBe(false);
    expect((await runtime.docker.getContainer(f.activeContainer).inspect()).State.Running).toBe(true);
  });
});
