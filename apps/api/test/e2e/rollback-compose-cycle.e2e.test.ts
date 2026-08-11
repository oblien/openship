/**
 * THE COMPOSE CYCLE: `rollback()` on a multi-service project, real daemon.
 *
 * Compose is where the old design broke worst — a release stores the `"compose"`
 * marker in `image_ref`, so a restore used to try `createContainer({ Image:
 * "compose" })`. It's also where per-service tracking matters: a deploy only
 * rebuilds what changed, so an untouched service's image must be reused, not
 * rebuilt.
 *
 * This drives the real entry point over a two-service stack where only ONE
 * service changed between releases, and asserts:
 *
 *   - the plan pins BOTH services — the changed one from its own release's row,
 *     the untouched one from the earlier row that actually built it
 *     (`effectiveImagesAsOf`), even though the target release recorded no image
 *     for it;
 *   - the restore needs no repository (nothing to build);
 *   - after the restore, the changed service serves the OLD version again while
 *     the unchanged service was never disturbed.
 *
 * Same two seams as the single-app cycle test: platform/runtime LOCATION and
 * GitHub check emission. Skips without a reachable daemon — and FAILS instead
 * under RUN_DOCKER_E2E=1, which is what CI sets (see test/helpers/docker-e2e.ts).
 */

import { it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { DockerRuntime, NoopInfraProvider, createHostExecutor } from "@repo/adapters";
import { repos } from "@repo/db";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import {
  seedOrg,
  seedProject,
  seedDeployment,
  seedService,
  seedServiceDeployment,
} from "../helpers/seed";

const BASE_IMAGE = "busybox:latest";
const WEB_V1 = "openship/e2e-compose-web:v1";
const WEB_V2 = "openship/e2e-compose-web:v2";
const API_V1 = "openship/e2e-compose-api:v1";
const SVC_PORT = 80;

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

describeDockerE2E("compose rollback cycle through the real entry point", () => {
  let runtime: DockerRuntime;
  let project: { id: string; organizationId: string; slug: string | null };
  let web: { id: string; name: string };
  let api: { id: string; name: string };
  let ready = false;
  let webPort = 0;
  let apiPort = 0;
  let contextDir = "";

  let rollbackMod: typeof import("../../src/modules/deployments/rollback");

  const buildImage = async (tag: string, body: string) => {
    await writeFile(
      join(contextDir, "Dockerfile"),
      [
        `FROM ${BASE_IMAGE}`,
        "RUN mkdir -p /www",
        `RUN printf '%s' '${body}' > /www/version.txt`,
        `EXPOSE ${SVC_PORT}`,
        `CMD ["httpd", "-f", "-p", "${SVC_PORT}", "-h", "/www"]`,
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
  };

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    try {
      await runtime.pullImage(BASE_IMAGE);
    } catch {
      return;
    }

    const org = await seedOrg();
    webPort = await freePort();
    apiPort = await freePort();
    project = (await seedProject(org.organizationId, {
      framework: "docker",
      hasBuild: false,
      hasServer: true,
      port: SVC_PORT,
      rollbackWindow: 3,
      runtimeMode: "docker",
      routeStrategy: "loopback-port",
    })) as never;

    // Two image-only services: the stack builds nothing, so a restore has no
    // source to fall back on — pins are the only way it can work.
    web = (await seedService(project.id, {
      name: "web",
      image: WEB_V2,
      ports: [`${webPort}:${SVC_PORT}`] as never,
    })) as never;
    api = (await seedService(project.id, {
      name: "api",
      image: API_V1,
      ports: [`${apiPort}:${SVC_PORT}`] as never,
    })) as never;

    contextDir = await mkdtemp(join(tmpdir(), "openship-compose-e2e-"));
    await buildImage(WEB_V1, "web-v1");
    await buildImage(WEB_V2, "web-v2");
    await buildImage(API_V1, "api-v1");

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
      return { ...actual, platform: () => localPlatform.platform };
    });
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
    for (const tag of [WEB_V1, WEB_V2, API_V1]) await runtime.removeImage(tag).catch(() => {});
    await runtime.removeNetwork(project.slug ?? project.id).catch(() => {});
    await runtime.dispose?.().catch(() => {});
    if (contextDir) await rm(contextDir, { recursive: true, force: true }).catch(() => {});
  }, 120_000);

  const composeSnapshot = (webImage: string) => ({
    framework: "docker",
    hasBuild: false,
    hasServer: true,
    port: SVC_PORT,
    deployTarget: "local" as const,
    runtimeMode: "docker" as const,
    serviceDeploymentMode: "services" as const,
    composeServices: [
      { id: web.id, name: "web", kind: "compose", image: webImage, enabled: true, ports: [`${webPort}:${SVC_PORT}`] },
      { id: api.id, name: "api", kind: "compose", image: API_V1, enabled: true, ports: [`${apiPort}:${SVC_PORT}`] },
    ],
  });

  it("pins BOTH services — including the one this release never rebuilt", async () => {
    expect(ready, "daemon unusable or base image unavailable").toBe(true);

    // ── v1: the release that built both services.
    const v1 = await seedDeployment(project, {
      commitSha: "1".repeat(40),
      imageRef: "compose", // the marker a compose release stores
      containerId: "compose",
      meta: composeSnapshot(WEB_V1) as never,
      version: 1,
      createdAt: new Date(Date.now() - 60 * 60_000) as never,
    });
    await seedServiceDeployment(v1.id, web, {
      imageRef: WEB_V1,
      createdAt: new Date(Date.now() - 59 * 60_000) as never,
    });
    await seedServiceDeployment(v1.id, api, {
      imageRef: API_V1,
      createdAt: new Date(Date.now() - 59 * 60_000) as never,
    });

    // ── v2: only `web` changed. `api` was skipped and recorded NO image —
    // exactly what a smart deploy leaves behind.
    const v2 = await seedDeployment(project, {
      commitSha: "2".repeat(40),
      imageRef: "compose",
      containerId: "compose",
      meta: composeSnapshot(WEB_V2) as never,
      version: 2,
      createdAt: new Date(Date.now() - 30 * 60_000) as never,
    });
    await seedServiceDeployment(v2.id, web, {
      imageRef: WEB_V2,
      createdAt: new Date(Date.now() - 29 * 60_000) as never,
    });
    await seedServiceDeployment(v2.id, api, {
      status: "skipped",
      reason: "unchanged",
      createdAt: new Date(Date.now() - 29 * 60_000) as never,
    });
    // Deliberately no active pointer yet: a release can't be "restored" onto
    // itself, so leaving the project without one lets both plans be inspected.
    // The next test establishes a live stack by deploying v2 for real.

    // The plan for v2: web from its own row, api resolved BACKWARDS to v1's row.
    const { plan } = await rollbackMod.resolveRestorePlan(v2.id);
    expect(plan).toMatchObject({
      mode: "redeploy-pinned",
      handoverImages: { web: WEB_V2, api: API_V1 },
      rebuildServices: [],
    });
    expect(rollbackMod.planNeedsRepository(plan)).toBe(false);

    // And for v1: web rolls back to WEB_V1, api stays on the image it never left.
    const v1Plan = (await rollbackMod.resolveRestorePlan(v1.id)).plan;
    expect(v1Plan).toMatchObject({
      mode: "redeploy-pinned",
      handoverImages: { web: WEB_V1, api: API_V1 },
      rebuildServices: [],
    });
  }, 120_000);

  it("rollback() brings the whole stack back to v1 without building anything", async () => {
    expect(ready).toBe(true);
    const { rows: before } = await repos.deployment.listByProject(project.id, { perPage: 50 });
    const v1 = before.find((r) => r.commitSha === "1".repeat(40))!;
    const known = new Set(before.map((r) => r.id));
    const imagesBefore = (await runtime.listProjectImages(project.id)).length;

    // Bring v2 up for real first, so the restore has a live stack to replace.
    await rollbackMod.rollback(v2Id(before));
    const forward = await waitForFresh(project.id, known);
    expect(forward.status, forward.errorMessage ?? "").toBe("ready");
    expect(await get(`http://127.0.0.1:${webPort}/version.txt`)).toBe("web-v2");
    expect(await get(`http://127.0.0.1:${apiPort}/version.txt`)).toBe("api-v1");

    // ── Now the actual rollback to v1.
    const known2 = new Set(
      (await repos.deployment.listByProject(project.id, { perPage: 50 })).rows.map((r) => r.id),
    );
    await rollbackMod.rollback(v1.id);
    const restore = await waitForFresh(project.id, known2);
    expect(restore.status, restore.errorMessage ?? "").toBe("ready");

    // web is back on v1; api — which nothing asked to change — still serves.
    expect(await get(`http://127.0.0.1:${webPort}/version.txt`)).toBe("web-v1");
    expect(await get(`http://127.0.0.1:${apiPort}/version.txt`)).toBe("api-v1");

    // NOTHING was built: the project's image set is unchanged.
    expect((await runtime.listProjectImages(project.id)).length).toBe(imagesBefore);

    // The restore's own per-service rows record what it actually ran.
    const rows = await repos.service.listByDeployment(restore.id);
    const byName = new Map(rows.map((r) => [r.serviceName, r.imageRef]));
    // Names included: a restore OF THIS restore keys its pins by service name, so
    // a null name here would silently rebuild the whole stack next time.
    expect(byName.get("web")).toBe(WEB_V1);
    expect(byName.get("api")).toBe(API_V1);
  }, 600_000);

  /** v2's id, from a listing (newest-first). */
  function v2Id(rows: Array<{ id: string; commitSha: string | null }>): string {
    return rows.find((r) => r.commitSha === "2".repeat(40))!.id;
  }

  async function waitForFresh(
    projectId: string,
    knownIds: Set<string>,
    timeoutMs = 300_000,
  ): Promise<{ id: string; status: string; errorMessage: string | null }> {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      const { rows } = await repos.deployment.listByProject(projectId, { perPage: 50 });
      const fresh = rows.find((r) => !knownIds.has(r.id));
      if (fresh) {
        last = fresh.status;
        if (["ready", "partial_failure", "failed", "cancelled"].includes(fresh.status)) {
          if (fresh.status !== "ready") {
            const session = await repos.deployment.findBuildSessionByDeploymentId(fresh.id);
            const logs = (session?.logs as Array<{ message: string }> | null) ?? [];
            console.error(
              `[compose restore ${fresh.id}] ${fresh.errorMessage ?? "no error"}\n` +
                logs.slice(-40).map((l) => l.message).join(""),
            );
          }
          return fresh as never;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`deploy never finished (last status: ${last || "no new row"})`);
  }
});
