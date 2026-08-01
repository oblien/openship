/**
 * The heavy half of the rollback proof: a REAL BUILD, then a restore that
 * doesn't build.
 *
 * The hermetic test (rollback-docker.e2e.test.ts) seeds prebuilt images so it can
 * run in seconds. This one closes the remaining gap — that an image produced by
 * the product's own build path is restorable, and that the restore genuinely
 * skips the build rather than quietly redoing it. It builds `fixtures/deploy/node`
 * twice (the fixtures README earmarks them for exactly this), redeploys, then
 * restores v1 from its retained image and asserts the response body reverts.
 *
 * Gated behind RUN_DOCKER_E2E=1 because each build pulls a Node base image and
 * takes minutes:
 *
 *   DOCKER_HOST=unix://$HOME/.colima/default/docker.sock \
 *   RUN_DOCKER_E2E=1 bun --cwd apps/api exec vitest run test/e2e/rollback-build-restore
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { BuildLogger, DockerRuntime, resolveLocalDockerSocketPath } from "@repo/adapters";
import { repos } from "@repo/db";
import { seedOrg, seedProject, seedDeployment, setActive } from "../helpers/seed";
import { pinnedAppImage, snapshotNeedsGitSource } from "../../src/modules/deployments/pinned-artifacts";

const enabled =
  process.env.RUN_DOCKER_E2E === "1" && existsSync(resolveLocalDockerSocketPath());

const FIXTURE = join(import.meta.dirname, "../../../../fixtures/deploy/node");
const APP_PORT = 3000;

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
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} never answered: ${String(lastErr)}`);
}

describe.skipIf(!enabled)("build → redeploy → restore without rebuilding", () => {
  let runtime: DockerRuntime;
  let project: { id: string; organizationId: string; slug: string | null };
  let sourceDir = "";
  let hostPort = 0;

  beforeAll(async () => {
    runtime = await DockerRuntime.create({ transport: "socket" });
    const org = await seedOrg();
    project = (await seedProject(org.organizationId, { rollbackWindow: 3 })) as never;
    sourceDir = await mkdtemp(join(tmpdir(), "openship-build-e2e-"));
    await cp(FIXTURE, sourceDir, { recursive: true });
    hostPort = await freePort();
  }, 120_000);

  afterAll(async () => {
    if (!enabled) return;
    for (const id of await runtime.listProjectContainerIds(project.id).catch(() => [])) {
      await runtime.destroy(id).catch(() => {});
    }
    for (const img of await runtime.listProjectImages(project.id).catch(() => [])) {
      for (const tag of img.repoTags) await runtime.removeImage(tag).catch(() => {});
    }
    await runtime.dispose?.().catch(() => {});
    if (sourceDir) await rm(sourceDir, { recursive: true, force: true }).catch(() => {});
  }, 180_000);

  /** Build the fixture through the product's own Docker build path. */
  const build = async (sessionId: string) =>
    runtime.build(
      {
        sessionId,
        projectId: project.id,
        slug: project.slug ?? project.id,
        repoUrl: "",
        branch: "main",
        localPath: sourceDir,
        stack: "node",
        buildImage: "node:22-alpine",
        packageManager: "npm",
        installCommand: "",
        buildCommand: "",
        startCommand: "node server.js",
        outputDirectory: "",
        port: APP_PORT,
        envVars: {},
        resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
      } as never,
      new BuildLogger(),
    );

  const deployConfig = (deploymentId: string, imageRef: string, version: string) => ({
    deploymentId,
    projectId: project.id,
    buildSessionId: `bs_${deploymentId}`,
    imageRef,
    environment: "production",
    port: APP_PORT,
    hostPort,
    startCommand: "node server.js",
    envVars: { APP_VERSION: version },
    resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
    restartPolicy: "always" as const,
    runtimeName: project.slug ?? project.id,
    slug: project.slug ?? project.id,
  });

  it("restores the FIRST build's image without running a build", async () => {
    // ── v1: real build of the fixture as shipped ("hello from node")
    const b1 = await build("sess_v1");
    expect(b1.status, b1.errorMessage ?? "").toBe("deploying");
    const v1 = await seedDeployment(project, {
      commitSha: "1".repeat(40),
      imageRef: b1.imageRef!,
      meta: { framework: "node", hasBuild: true, port: APP_PORT } as never,
    });
    const r1 = await runtime.deploy(deployConfig(v1.id, b1.imageRef!, "v1"));
    await repos.deployment.setContainerId(v1.id, r1.containerId!, r1.url);
    await setActive(project.id, v1.id);
    expect(await get(`http://127.0.0.1:${hostPort}/`)).toBe("hello from node");

    // ── v2: change the source and build again ("hello from node v2")
    await writeFile(
      join(sourceDir, "server.js"),
      [
        'const http = require("http");',
        `const port = Number(process.env.PORT) || ${APP_PORT};`,
        'http.createServer((_req, res) => { res.writeHead(200); res.end("hello from node v2\\n"); }).listen(port);',
        "",
      ].join("\n"),
    );
    const b2 = await build("sess_v2");
    expect(b2.status, b2.errorMessage ?? "").toBe("deploying");
    expect(b2.imageRef).not.toBe(b1.imageRef); // every build mints its own tag
    const v2 = await seedDeployment(project, {
      commitSha: "2".repeat(40),
      imageRef: b2.imageRef!,
      meta: { framework: "node", hasBuild: true, port: APP_PORT } as never,
    });
    await runtime.destroy(r1.containerId!);
    const r2 = await runtime.deploy(deployConfig(v2.id, b2.imageRef!, "v2"));
    await repos.deployment.setContainerId(v2.id, r2.containerId!, r2.url);
    await setActive(project.id, v2.id);
    expect(await get(`http://127.0.0.1:${hostPort}/`)).toBe("hello from node v2");

    // ── restore v1 from its retained image. The snapshot pins it, which is what
    // tells the pipeline there's nothing to clone or build.
    const restoreSnapshot = {
      framework: "node",
      hasBuild: true,
      port: APP_PORT,
      handoverAppImage: b1.imageRef!,
    };
    expect(pinnedAppImage(restoreSnapshot)).toBe(b1.imageRef);
    expect(snapshotNeedsGitSource(restoreSnapshot)).toBe(false);
    expect(await runtime.imageExistsLocally(b1.imageRef!)).toBe(true);

    const restore = await seedDeployment(project, {
      commitSha: v1.commitSha,
      imageRef: b1.imageRef!,
      trigger: "rollback",
      commitShaBefore: v2.commitSha,
      meta: restoreSnapshot as never,
    });
    await runtime.destroy(r2.containerId!);
    const restored = await runtime.deploy(deployConfig(restore.id, b1.imageRef!, "v1"));
    await repos.deployment.setContainerId(restore.id, restored.containerId!, restored.url);
    await setActive(project.id, restore.id);

    // The ORIGINAL build's bytes are serving again — no rebuild involved.
    expect(await get(`http://127.0.0.1:${hostPort}/`)).toBe("hello from node");
  }, 1_800_000);
});
