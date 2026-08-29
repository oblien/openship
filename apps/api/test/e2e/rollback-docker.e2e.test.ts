/**
 * Rollback against a REAL Docker daemon.
 *
 * The proof that the restore architecture works end to end, driven through the
 * product's own functions: a real daemon, real images, real containers, a real
 * (in-memory PGlite) database with real rows, the real retention orchestrator and
 * the real restore planner. Nothing about the daemon is simulated — the only
 * dockerode used is the one `DockerRuntime` itself holds, and it's used only to
 * INSPECT what the product did.
 *
 * What each test establishes:
 *
 *   1. THE PREMISE — a redeploy REMOVES the previous container (that's what the
 *      pipeline's deactivate does under loopback-port routing, since two
 *      containers can't share one host port) while the previous IMAGE survives
 *      the reap. So "restart the old container" is not a rollback strategy on
 *      Docker; the image is the artifact.
 *
 *   2. THE PLAN — `planRestore`, given those real rows and real image presence,
 *      resolves `redeploy-pinned` with the right tag, and degrades to `rebuild`
 *      once the tag is actually gone from the daemon.
 *
 *   3. THE MATERIALIZATION — restoring through the normal deploy primitive with
 *      the frozen snapshot's image yields a COMPLETE container: the frozen env,
 *      the pinned loopback publish, the volume bind, the openship labels and the
 *      resource caps — and it serves the OLD version's bytes over
 *      127.0.0.1:<hostPort>. The container the removed `makeActive` stub built
 *      had none of those, which is exactly why a "successful" rollback used to
 *      leave a 502 with detached volumes.
 *
 *   4. RETENTION — prune against the real daemon withholds an image another
 *      retained release still points at (a restore shares its source's tag).
 *
 * ONE seam is faked: `resolveDeploymentRuntime`, so the orchestrator gets this
 * local-socket runtime instead of building a full platform (which on Linux would
 * provision OpenResty). Everything the runtime then DOES is real.
 *
 * Gated by `requireDocker()` (test/helpers/docker-e2e.ts): CI runs this with
 * RUN_DOCKER_E2E=1, where an unreachable daemon FAILS instead of skipping. The
 * socket is resolved the way the product resolves it, so Colima / Rancher /
 * Podman / rootless are found via their docker context or DOCKER_HOST.
 */

import { it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { DockerRuntime } from "@repo/adapters";
import { repos } from "@repo/db";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { seedOrg, seedProject, seedDeployment, setActive } from "../helpers/seed";

const BASE_IMAGE = "busybox:latest";
const TAG_V1 = "openship/e2e-rollback:v1";
const TAG_V2 = "openship/e2e-rollback:v2";
const APP_PORT = 80;

/** A free loopback port, the way the allocator's callers use one: bind :0, read
 *  what the kernel gave us, release it. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll until the app answers — a container is "started" before it's listening. */
async function get(url: string, attempts = 40): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return (await res.text()).trim();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} never answered: ${String(lastErr)}`);
}

describeDockerE2E("rollback against a real Docker daemon", () => {
  let runtime: DockerRuntime;
  let project: { id: string; organizationId: string; slug: string | null };
  let ready = false;
  let hostPort = 0;
  let contextDir = "";

  type Rollback = typeof import("../../src/modules/deployments/rollback");
  type Planner = typeof import("../../src/modules/deployments/rollback/restore-plan");
  let rollback: Rollback;
  let planner: Planner;

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });

    // Tiny base image. Needs network exactly once, then it's cached. `pullImage`
    // is the product's own pull path.
    try {
      await runtime.pullImage(BASE_IMAGE);
    } catch {
      return; // no network on a cold cache — leave `ready` false
    }

    const org = await seedOrg();
    project = (await seedProject(org.organizationId, {
      rollbackWindow: 2,
      // The DEFAULT strategy. Instant restore must work here too — that it
      // didn't (artifact_retained_at stayed null) is what disabled the UI's
      // rollback action for every default project.
      defaultRollbackStrategy: "git",
    })) as never;

    // Two versions of a one-file HTTP server, so "which version is live?" is an
    // HTTP GET rather than an inference. Labelled the way a real build labels
    // images, so listProjectImages / the keep set see them.
    contextDir = await mkdtemp(join(tmpdir(), "openship-rollback-e2e-"));
    for (const [tag, version] of [
      [TAG_V1, "v1"],
      [TAG_V2, "v2"],
    ] as const) {
      await writeFile(
        join(contextDir, "Dockerfile"),
        [
          `FROM ${BASE_IMAGE}`,
          "RUN mkdir -p /www /data",
          `RUN printf '%s' '${version}' > /www/version.txt`,
          `EXPOSE ${APP_PORT}`,
          `CMD ["httpd", "-f", "-p", "${APP_PORT}", "-h", "/www"]`,
          "",
        ].join("\n"),
      );
      const stream = await runtime.docker.buildImage(
        { context: contextDir, src: ["Dockerfile"] },
        { t: tag, labels: { "openship.project": project.id } },
      );
      await new Promise<void>((resolve, reject) => {
        runtime.docker.modem.followProgress(stream, (err: Error | null) =>
          err ? reject(err) : resolve(),
        );
      });
    }

    // The one seam: hand the orchestrator THIS runtime instead of building a
    // platform (which on Linux would provision OpenResty). Everything the
    // runtime then does hits the real daemon.
    vi.doMock("../../src/lib/deployment-runtime", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        resolveDeploymentRuntime: async () => ({ runtime, serverId: null }),
      };
    });

    rollback = await import("../../src/modules/deployments/rollback");
    planner = await import("../../src/modules/deployments/rollback/restore-plan");
    hostPort = await freePort();
    ready = true;
  }, 300_000);

  afterAll(async () => {
    if (!project) return;
    for (const id of await runtime.listProjectContainerIds(project.id).catch(() => [])) {
      await runtime.destroy(id).catch(() => {});
    }
    for (const tag of [TAG_V1, TAG_V2]) await runtime.removeImage(tag).catch(() => {});
    await runtime.docker
      .getVolume(`openship-${project.slug}-data`)
      .remove({ force: true } as never)
      .catch(() => {});
    await runtime.dispose?.().catch(() => {});
    if (contextDir) await rm(contextDir, { recursive: true, force: true }).catch(() => {});
  }, 120_000);

  /** The frozen per-deploy snapshot a restore replays. */
  const snapshotFor = (version: string) => ({
    framework: "docker",
    hasBuild: true,
    port: APP_PORT,
    resources: { cpuCores: 0, memoryMb: 256, diskMb: 0 },
    volumes: ["data:/data"],
    deployTarget: "local" as const,
    runtimeMode: "docker" as const,
    envVars: { APP_VERSION: version },
  });

  /** The deploy config the pipeline derives from that snapshot. Used for BOTH the
   *  original deploys and the restore, which is the point: a restore is the same
   *  deploy call with the image pinned instead of built. */
  const deployConfigFor = (
    deploymentId: string,
    imageRef: string,
    snapshot: ReturnType<typeof snapshotFor>,
  ) => ({
    deploymentId,
    projectId: project.id,
    buildSessionId: `bs_${deploymentId}`,
    imageRef,
    environment: "production",
    port: snapshot.port,
    hostPort,
    envVars: snapshot.envVars,
    resources: snapshot.resources,
    restartPolicy: "always" as const,
    runtimeName: project.slug ?? project.id,
    slug: project.slug ?? project.id,
    volumes: snapshot.volumes,
  });

  const findByImage = async (tag: string) => {
    const rows = await repos.deployment.listReadyOrderedDesc(project.id);
    const row = rows.find((d) => d.imageRef === tag);
    if (!row) throw new Error(`no deployment row for ${tag}`);
    return row;
  };

  it("a redeploy REMOVES the previous container but keeps its image restorable", async () => {
    expect(ready, "daemon unusable or base image unavailable").toBe(true);

    const v1 = await seedDeployment(project, {
      commitSha: "1".repeat(40),
      imageRef: TAG_V1,
      meta: snapshotFor("v1") as never,
    });
    const r1 = await runtime.deploy(deployConfigFor(v1.id, TAG_V1, snapshotFor("v1")));
    expect(r1.containerId).toBeTruthy();
    await repos.deployment.setContainerId(v1.id, r1.containerId!, r1.url);
    await setActive(project.id, v1.id);

    expect(await get(`http://127.0.0.1:${hostPort}/version.txt`)).toBe("v1");

    // Redeploy to v2 the way the pipeline does under loopback-port routing:
    // destroy the old container (it holds the host port), then start the new one.
    const v2 = await seedDeployment(project, {
      commitSha: "2".repeat(40),
      imageRef: TAG_V2,
      meta: snapshotFor("v2") as never,
    });
    await runtime.destroy(r1.containerId!);
    const r2 = await runtime.deploy(deployConfigFor(v2.id, TAG_V2, snapshotFor("v2")));
    await repos.deployment.setContainerId(v2.id, r2.containerId!, r2.url);
    await setActive(project.id, v2.id);

    // Real retention bookkeeping — this also reaps superseded images.
    await rollback.onDeploymentReady({
      newDeployment: (await repos.deployment.findById(v2.id))!,
      previousActive: (await repos.deployment.findById(v1.id))!,
    });

    expect(await get(`http://127.0.0.1:${hostPort}/version.txt`)).toBe("v2");

    // THE PREMISE: v1's container is gone …
    await expect(runtime.docker.getContainer(r1.containerId!).inspect()).rejects.toThrow();
    // … while v1's image is still on the host, because it's inside the window.
    expect(await runtime.imageExistsLocally(TAG_V1)).toBe(true);

    // Both rows are marked restorable — on a "git"-strategy project, which used
    // to leave this null and disable rollback in the dashboard entirely.
    expect((await repos.deployment.findById(v1.id))!.artifactRetainedAt).toBeTruthy();
    expect((await repos.deployment.findById(v2.id))!.artifactRetainedAt).toBeTruthy();
  }, 300_000);

  it("plans an INSTANT restore of v1 from its retained image", async () => {
    expect(ready).toBe(true);
    const v1 = await findByImage(TAG_V1);
    const proj = (await repos.project.findById(project.id))!;

    const plan = planner.planRestore({
      target: v1,
      project: proj,
      unitRestore: false, // docker: the image is the artifact, not a unit
      serviceImages: [],
      imagePresent: (ref) => ref === TAG_V1 || ref === TAG_V2,
    });

    expect(plan).toMatchObject({ mode: "redeploy-pinned", handoverAppImage: TAG_V1 });
    expect(planner.planNeedsRepository(plan)).toBe(false); // no clone, no token
  });

  it("restores v1 as a COMPLETE container — env, pinned port, volume, labels, caps", async () => {
    expect(ready).toBe(true);
    const v1 = await findByImage(TAG_V1);
    const v2 = await findByImage(TAG_V2);
    const snapshot = v1.meta as ReturnType<typeof snapshotFor>;

    // What a restore is: a NEW deployment row (the pointer only moves forward)
    // that deploys the FROZEN snapshot with the retained image pinned — no build.
    const restore = await seedDeployment(project, {
      commitSha: v1.commitSha,
      imageRef: TAG_V1,
      trigger: "rollback",
      commitShaBefore: v2.commitSha,
      meta: { ...snapshot, handoverAppImage: TAG_V1 } as never,
    });
    await runtime.destroy(v2.containerId!);
    const restored = await runtime.deploy(deployConfigFor(restore.id, TAG_V1, snapshot));
    await repos.deployment.setContainerId(restore.id, restored.containerId!, restored.url);
    await setActive(project.id, restore.id);

    // It SERVES the old version, on the same pinned loopback port the edge dials.
    expect(await get(`http://127.0.0.1:${hostPort}/version.txt`)).toBe("v1");

    const info = await runtime.docker.getContainer(restored.containerId!).inspect();
    // …with the frozen env (the stub shipped none → apps crash-looped on a
    // missing DATABASE_URL).
    expect(info.Config.Env).toContain("APP_VERSION=v1");
    // …published on 127.0.0.1:<pinned> (the stub published nothing → edge 502).
    expect(info.HostConfig.PortBindings[`${APP_PORT}/tcp`]).toEqual([
      { HostIp: "127.0.0.1", HostPort: String(hostPort) },
    ]);
    // …with the project-scoped volume reattached (the stub dropped binds → the
    // app came back with an empty data directory).
    expect(info.HostConfig.Binds ?? []).toContain(`openship-${project.slug}-data:/data`);
    // …labelled, so live state, the image-GC keep set and teardown can all find
    // it (the stub's container was invisible to every one of them).
    expect(info.Config.Labels["openship.project"]).toBe(project.id);
    expect(info.Config.Labels["openship.deployment"]).toBe(restore.id);
    // …and with the caps this release originally had.
    expect(info.HostConfig.Memory).toBe(256 * 1024 * 1024);
  }, 180_000);

  it("degrades to a rebuild once the retained image is really gone", async () => {
    expect(ready).toBe(true);
    const v2 = await findByImage(TAG_V2);
    const proj = (await repos.project.findById(project.id))!;

    await runtime.removeImage(TAG_V2);
    expect(await runtime.imageExistsLocally(TAG_V2)).toBe(false);

    const plan = planner.planRestore({
      target: v2,
      project: proj,
      unitRestore: false,
      serviceImages: [],
      // Presence is resolved by the caller; here the daemon really doesn't have it.
      imagePresent: (ref) => ref !== TAG_V2 && ref !== TAG_V1,
    });

    // Not an error — the commit is the other artifact.
    expect(plan).toEqual({ mode: "rebuild", commitSha: v2.commitSha });
    expect(planner.planNeedsRepository(plan)).toBe(true);
  }, 120_000);

  it("prune withholds an image the live release still shares", async () => {
    expect(ready).toBe(true);
    // The restore reused v1's tag, so the older v1 row and the active restore row
    // point at ONE image. Squeeze the window so the v1 row overflows.
    await repos.project.update(project.id, { rollbackWindow: 0 });

    await rollback.prune(project.id);

    // The shared image survives, because the ACTIVE release is running it …
    expect(await runtime.imageExistsLocally(TAG_V1)).toBe(true);
    // … and the live container is still serving.
    expect(await get(`http://127.0.0.1:${hostPort}/version.txt`)).toBe("v1");
  }, 120_000);
});
