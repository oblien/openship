/**
 * THE FULL CYCLE: `rollback()` itself, against a real Docker daemon.
 *
 * The sibling test (rollback-docker.e2e.test.ts) proves the daemon-level facts by
 * reproducing what a restore does. This one proves the WIRING — it calls the
 * product's own entry point and lets the whole chain run:
 *
 *   rollback(id)
 *     → resolveRestorePlan            (real: reads rows, asks the daemon)
 *     → restoreViaRedeploy            (real: builds the reuseSnapshot)
 *     → triggerDeployment             (real: preflight, queued row, kickoff)
 *     → executeBuildAndDeploy         (real pipeline)
 *         → snapshotNeedsGitSource    → false, so NO clone and NO git token
 *         → reuseRetainedArtifact     → the pinned image, so NO build
 *         → runtime.deploy            (real container)
 *         → onSuccess                 (real: version, active pointer)
 *         → onDeploymentReady          (real: retention + prune + image reap)
 *
 * Faked seams, and only these: how the platform/runtime is LOCATED (so the test
 * doesn't provision OpenResty), and GitHub check-run emission (no installation).
 * Everything those seams return is real — a local-socket DockerRuntime and the
 * Noop routing/ssl providers a desktop/local platform already uses.
 *
 * Skips without a reachable daemon — and FAILS instead under RUN_DOCKER_E2E=1,
 * which is what CI sets (see test/helpers/docker-e2e.ts). A non-default socket is
 * found via the active docker context or DOCKER_HOST.
 */

import { it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { DockerRuntime, NoopInfraProvider, createHostExecutor } from "@repo/adapters";
import { repos } from "@repo/db";
import { encrypt } from "../../src/lib/encryption";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { seedOrg, seedProject, seedDeployment, setActive } from "../helpers/seed";

const BASE_IMAGE = "busybox:latest";
const TAG_V1 = "openship/e2e-cycle:v1";
const TAG_V2 = "openship/e2e-cycle:v2";
const APP_PORT = 80;

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

async function get(url: string, attempts = 60): Promise<string> {
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

/** The deploy runs in the background (kickoffBuild fires and forgets), so wait
 *  for the row the restore created to reach a terminal status. */
async function waitForRestore(
  projectId: string,
  knownIds: Set<string>,
  timeoutMs = 180_000,
): Promise<{
  id: string;
  status: string;
  imageRef: string | null;
  containerId: string | null;
  errorMessage: string | null;
}> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const { rows } = await repos.deployment.listByProject(projectId, { perPage: 50 });
    const fresh = rows.find((r) => !knownIds.has(r.id));
    if (fresh) {
      last = fresh.status;
      if (["ready", "partial_failure", "failed", "cancelled"].includes(fresh.status)) {
        return fresh as never;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`restore never finished (last status: ${last || "no new row"})`);
}

describeDockerE2E("full rollback cycle through the real entry point", () => {
  let runtime: DockerRuntime;
  let project: { id: string; organizationId: string; slug: string | null };
  let ready = false;
  let hostPort = 0;
  let contextDir = "";
  let sourceDir = "";

  let rollbackMod: typeof import("../../src/modules/deployments/rollback");

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    try {
      await runtime.pullImage(BASE_IMAGE);
    } catch {
      return;
    }

    const org = await seedOrg();
    // The pipeline pins ONE loopback port per project (project.host_port) and
    // reuses it across deploys — that stability is what lets the edge keep
    // pointing at the same upstream through a restore. Seed it, as a project that
    // has deployed once already would have.
    hostPort = await freePort();
    // A local-path project: no git remote, so the restore has nothing to clone
    // even if it wanted to — which is exactly the invariant under test.
    sourceDir = await mkdtemp(join(tmpdir(), "openship-cycle-src-"));
    await writeFile(join(sourceDir, "index.html"), "<h1>ignored</h1>\n");
    project = (await seedProject(org.organizationId, {
      localPath: sourceDir,
      framework: "docker",
      hasBuild: true,
      hasServer: true,
      port: APP_PORT,
      hostPort,
      rollbackWindow: 3,
      runtimeMode: "docker",
      routeStrategy: "loopback-port",
    })) as never;

    contextDir = await mkdtemp(join(tmpdir(), "openship-cycle-ctx-"));
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

    // ── Seams ────────────────────────────────────────────────────────────
    // 1. Platform/runtime LOCATION only. What comes back is a real local-socket
    //    DockerRuntime plus the Noop routing/ssl a local platform already gets;
    //    `system: null` keeps the edge toolchain out of a test box.
    const localPlatform = {
      platform: {
        target: "selfhosted" as const,
        runtime,
        routing: new NoopInfraProvider(),
        ssl: new NoopInfraProvider(),
        system: null,
        executor: createHostExecutor(),
      },
      effectiveTarget: "local" as const,
      runtimeMode: "docker" as const,
      usesManagedRouting: false,
      serverId: null,
    };
    vi.doMock("../../src/lib/deployment-runtime", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        resolveDeploymentRuntime: async () => ({ runtime, serverId: null }),
        resolveDeploymentPlatform: async () => localPlatform,
        resolveServerExecutor: async () => ({
          id: "local",
          executor: createHostExecutor(),
          conn: { host: "127.0.0.1", port: 22, user: "root" },
          isLocal: true,
          ssh: null,
        }),
      };
    });
    vi.doMock("../../src/lib/controller-helpers", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        platform: () => localPlatform.platform,
      };
    });
    // 2. GitHub check runs: there's no installation in a test org.
    // Keep everything real except the GitHub calls (no installation in a test org).
    vi.doMock("../../src/modules/deployments/service-checks", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        emitInitialServiceChecks: async () => {},
        emitServiceCheckResults: async () => {},
        emitDeploymentCheck: async () => {},
        completeDeploymentCheck: async () => {},
      };
    });

    rollbackMod = await import("../../src/modules/deployments/rollback");
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
    for (const dir of [contextDir, sourceDir]) {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);

  const snapshotFor = (version: string) => ({
    framework: "docker",
    hasBuild: true,
    hasServer: true,
    port: APP_PORT,
    localPath: sourceDir,
    deployTarget: "local" as const,
    runtimeMode: "docker" as const,
    buildStrategy: "server" as const,
    resources: { cpuCores: 0, memoryMb: 256, diskMb: 0 },
    volumes: ["data:/data"],
    envVars: { APP_VERSION: version },
    serviceDeploymentMode: "single" as const,
  });

  const deployConfigFor = (deploymentId: string, imageRef: string, version: string) => ({
    deploymentId,
    projectId: project.id,
    buildSessionId: `bs_${deploymentId}`,
    imageRef,
    environment: "production",
    port: APP_PORT,
    hostPort,
    envVars: { APP_VERSION: version },
    resources: { cpuCores: 0, memoryMb: 256, diskMb: 0 },
    restartPolicy: "always" as const,
    runtimeName: project.slug ?? project.id,
    slug: project.slug ?? project.id,
    volumes: ["data:/data"],
  });

  it("rollback() restores the previous release with no clone and no build", async () => {
    expect(ready, "daemon unusable or base image unavailable").toBe(true);

    // ── Arrange: two releases, v2 live. Seeded at the runtime level (the sibling
    // test already proves the deploy step); the CYCLE is what's under test here.
    const v1 = await seedDeployment(project, {
      commitSha: "1".repeat(40),
      commitMessage: "first release",
      imageRef: TAG_V1,
      meta: snapshotFor("v1") as never,
      // The release's env, frozen and encrypted exactly as a real deploy stores
      // it. A restore must ship THIS, not whatever the project's env says today.
      envVars: { APP_VERSION: encrypt("v1") } as never,
      version: 1,
    });
    const r1 = await runtime.deploy(deployConfigFor(v1.id, TAG_V1, "v1"));
    await repos.deployment.setContainerId(v1.id, r1.containerId!, r1.url);
    await setActive(project.id, v1.id);
    expect(await get(`http://127.0.0.1:${hostPort}/version.txt`)).toBe("v1");

    const v2 = await seedDeployment(project, {
      commitSha: "2".repeat(40),
      commitMessage: "second release",
      imageRef: TAG_V2,
      meta: snapshotFor("v2") as never,
      envVars: { APP_VERSION: encrypt("v2") } as never,
      version: 2,
    });
    await runtime.destroy(r1.containerId!); // what the pipeline's deactivate does
    const r2 = await runtime.deploy(deployConfigFor(v2.id, TAG_V2, "v2"));
    await repos.deployment.setContainerId(v2.id, r2.containerId!, r2.url);
    await setActive(project.id, v2.id);
    await rollbackMod.onDeploymentReady({
      newDeployment: (await repos.deployment.findById(v2.id))!,
      previousActive: (await repos.deployment.findById(v1.id))!,
    });
    expect(await get(`http://127.0.0.1:${hostPort}/version.txt`)).toBe("v2");

    const imagesBefore = (await runtime.listProjectImages(project.id)).length;
    const known = new Set([v1.id, v2.id]);

    // ── Act: the real entry point. Nothing else.
    await rollbackMod.rollback(v1.id);

    // ── Assert: a new release came up from v1's retained image.
    const restore = await waitForRestore(project.id, known);
    if (restore.status !== "ready") {
      // Surface the pipeline's own log when this fails — otherwise a red test
      // here says only "failed" and the next person re-derives why from scratch.
      const session = await repos.deployment.findBuildSessionByDeploymentId(restore.id);
      const logs = (session?.logs as Array<{ message: string }> | null) ?? [];
      console.error(
        `[restore ${restore.id}] ${restore.errorMessage ?? "no error"}\n` +
          logs.slice(-40).map((l) => l.message).join(""),
      );
    }
    expect(restore.status, restore.errorMessage ?? "no error recorded").toBe("ready");
    expect(restore.imageRef).toBe(TAG_V1);

    const row = (await repos.deployment.findById(restore.id))!;
    expect(row.trigger).toBe("rollback");
    // The restore is itself reversible: it records where it came FROM.
    expect(row.commitShaBefore).toBe("2".repeat(40));
    // The pointer moved FORWARD to the new row (never back to v1's row).
    expect((await repos.project.findById(project.id))!.activeDeploymentId).toBe(restore.id);
    // onSuccess reuses a commit's version, so this reads as v1 again.
    expect(row.version).toBe(1);

    // NO BUILD happened: the image set is unchanged and the restore runs v1's tag.
    expect((await runtime.listProjectImages(project.id)).length).toBe(imagesBefore);

    // NO CLONE happened: this project has no git remote at all, so a restore that
    // needed source could not have succeeded.
    expect((await repos.project.findById(project.id))!.gitUrl).toBeFalsy();

    // And v1's bytes are serving again, through the pipeline's own deploy step.
    expect(await get(`http://127.0.0.1:${hostPort}/version.txt`)).toBe("v1");

    const info = await runtime.docker.getContainer(row.containerId!).inspect();
    expect(info.Config.Env).toContain("APP_VERSION=v1"); // frozen env, not today's
    expect(info.HostConfig.Binds ?? []).toContain(`openship-${project.slug}-data:/data`);
    expect(info.Config.Labels["openship.deployment"]).toBe(restore.id);

    // Retention ran as part of the cycle: the restore is retained, v2 stays
    // restorable (it's the release we rolled back FROM).
    expect(row.artifactRetainedAt).toBeTruthy();
    expect((await repos.deployment.findById(v2.id))!.artifactRetainedAt).toBeTruthy();
    expect(await runtime.imageExistsLocally(TAG_V2)).toBe(true);
  }, 300_000);

  it("rolling forward again is symmetric — v2 comes back the same way", async () => {
    expect(ready).toBe(true);
    const { rows } = await repos.deployment.listByProject(project.id, { perPage: 50 });
    const v2 = rows.find((r) => r.imageRef === TAG_V2)!;
    const known = new Set(rows.map((r) => r.id));

    await rollbackMod.rollback(v2.id);

    const restore = await waitForRestore(project.id, known);
    expect(restore.status, restore.errorMessage ?? "no error recorded").toBe("ready");
    expect(restore.imageRef).toBe(TAG_V2);
    expect(await get(`http://127.0.0.1:${hostPort}/version.txt`)).toBe("v2");
    // Version numbering follows the COMMIT, so this is v2 again — not v4.
    expect((await repos.deployment.findById(restore.id))!.version).toBe(2);
  }, 300_000);

  it("refuses to roll back to the release that is already live", async () => {
    expect(ready).toBe(true);
    const active = (await repos.project.findById(project.id))!.activeDeploymentId!;
    await expect(rollbackMod.rollback(active)).rejects.toThrow(/already active/i);
  });

  it("plans a rebuild — not a failure — once the artifact is gone", async () => {
    expect(ready).toBe(true);
    const { rows } = await repos.deployment.listByProject(project.id, { perPage: 50 });
    // listByProject is newest-first, so the LAST v1-image row is the original.
    const target = [...rows].reverse().find((r) => r.imageRef === TAG_V1)!;
    await runtime.removeImage(TAG_V1);
    expect(await runtime.imageExistsLocally(TAG_V1)).toBe(false);

    const { plan } = await rollbackMod.resolveRestorePlan(target.id);
    expect(plan.mode).toBe("rebuild");
    expect(rollbackMod.planNeedsRepository(plan)).toBe(true);
  }, 120_000);
});
