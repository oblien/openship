/**
 * The backup half, against a real Docker daemon: capture a volume, destroy its
 * contents, restore it, and prove the bytes came back.
 *
 * Everything else in test/e2e proves ROLLBACK (image retention + redeploy). This
 * is the only test that drives backup and restore through the product's own
 * orchestrators against real volumes, a real `alpine:3` helper container, and a
 * real destination on disk. The unit suites under test/modules/backups fake the
 * storage backend and the executor — which is exactly why #434 (an unbounded
 * `helper.wait()` and a `startService` that threw on a null containerId) survived
 * a green test run: neither fake could hang, and neither had a container to
 * miss.
 *
 * What it pins that a fake cannot:
 *   - tar → zstd → destination → zstd → tar actually round-trips a volume.
 *   - The sha256 recorded at capture is the sha256 prepare re-computes from the
 *     destination's bytes (`meta.integrity === "sha256"`), and the manifest
 *     written at capture is the manifest prepare validates.
 *   - #434's shape restores end to end: the service row has NO container, so
 *     `isRunning()` is false, nothing is stopped, and nothing is started — the
 *     old code stopped unconditionally and always started, which threw here.
 *   - No helper container is left behind (`AutoRemove: false` + `finally` reap).
 *
 * The local destination is a tmpdir, not the default `BACKUP_LOCAL_ROOT`: the
 * root/deny-list rules are create-time gates in destination.service.ts and are
 * covered by test/modules/backups/local-destination-path.test.ts. The adapter
 * itself reads no env — it takes the row's endpoint as its root.
 *
 * Skips without a reachable daemon, FAILS under RUN_DOCKER_E2E=1 (what CI sets).
 * See test/helpers/docker-e2e.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRuntime, initPlatform, resetPlatform, scopedVolumeName } from "@repo/adapters";
import { repos, type BackupRestoreStatus } from "@repo/db";
import type { RequestContext } from "../../src/lib/request-context";
import { resolvePlatformConfig } from "../../src/lib/controller-helpers";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import {
  seedOrg,
  seedProject,
  seedDeployment,
  setActive,
  seedService,
  seedBackupDestination,
  seedBackupPolicy,
  seedBackupRun,
} from "../helpers/seed";
import { backupOrchestrator } from "../../src/modules/backups/backup.orchestrator";
import { restoreOrchestrator } from "../../src/modules/backups/restore.orchestrator";

/** Same image the executor's helpers use, so the test adds no extra pull. */
const HELPER_IMAGE = "alpine:3";
/** The volume as compose declares it; the executor scopes it per project. */
const VOLUME_SPEC = "data:/data";
const SENTINEL = "openship-backup-roundtrip-🎯";
const NESTED = "nested payload, deliberately in a subdirectory";

/** Files the fixture writes, as `find` reports them once restored. */
const EXPECTED_TREE = ["/mnt/nested/deep.txt", "/mnt/sentinel.txt"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TERMINAL: ReadonlySet<BackupRestoreStatus> = new Set<BackupRestoreStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "server_error",
]);

describeDockerE2E("backup → wipe → restore, real volume", () => {
  let runtime: DockerRuntime;
  let ctx: RequestContext;
  let volumeName = "";
  let destRoot = "";
  let projectId = "";
  let serviceId = "";
  let policyId = "";
  let destinationId = "";
  let organizationId = "";

  /**
   * Run a script with the target volume mounted at /mnt.
   *
   * `Tty: true` keeps the attach stream raw so the output needs no demux — this
   * is fixture plumbing, not the code under test. Removed in `finally` so the
   * leaked-helper assertion at the end can only ever accuse the product.
   */
  const inVolume = async (script: string): Promise<string> => {
    const helper = await runtime.docker.createContainer({
      Image: HELPER_IMAGE,
      Cmd: ["sh", "-c", script],
      HostConfig: { Binds: [`${volumeName}:/mnt`], AutoRemove: false },
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    try {
      const stream = await helper.attach({ stream: true, stdout: true, stderr: true });
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      await helper.start();
      const exit = (await helper.wait()) as { StatusCode: number };
      const out = Buffer.concat(chunks).toString("utf8");
      if (exit.StatusCode !== 0) {
        throw new Error(`fixture helper exited ${exit.StatusCode}: ${out}`);
      }
      return out;
    } finally {
      await helper.remove({ force: true }).catch(() => {});
    }
  };

  const containerIds = async (): Promise<Set<string>> =>
    new Set((await runtime.docker.listContainers({ all: true })).map((c) => c.Id));

  /** Poll the row the way the dashboard does — prepare and apply are fired into
   *  the background by design, so there is nothing to await. */
  const waitForRestore = async (restoreId: string, want: BackupRestoreStatus) => {
    const deadline = Date.now() + 300_000;
    for (;;) {
      const row = await repos.backupRestore.findById(restoreId);
      if (row?.status === want) return row;
      if (row && TERMINAL.has(row.status)) {
        throw new Error(
          `restore ${restoreId} reached ${row.status} instead of ${want}: ${row.errorMessage ?? "(no error recorded)"}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(`restore ${restoreId} stuck in ${row?.status ?? "gone"}, wanted ${want}`);
      }
      await sleep(250);
    }
  };

  beforeAll(async () => {
    await requireDocker();
    // The orchestrators resolve their executor through the global platform, so
    // the test has to initialize it the way `app.ts` does at startup — same
    // config function, no stand-in. With no DEPLOY_MODE that is selfhosted+docker.
    await initPlatform(resolvePlatformConfig());
    runtime = await DockerRuntime.create({ transport: "socket" });
    // Pulled here so a cold daemon costs the fixture, not the first assertion.
    await runtime.pullImage(HELPER_IMAGE);

    const org = await seedOrg();
    organizationId = org.organizationId;
    const slug = `bk-e2e-${randomBytes(4).toString("hex")}`;
    const project = await seedProject(organizationId, { slug, name: slug });
    projectId = project.id;

    // The platform is resolved from the ACTIVE deployment's snapshot, exactly as
    // a production backup resolves it, so the meta has to say local+docker or the
    // orchestrator picks the bare executor and tars the API host instead.
    const dep = await seedDeployment(project, {
      status: "ready",
      meta: { deployTarget: "local", runtimeMode: "docker" } as never,
    });
    await setActive(projectId, dep.id);

    // No containerId anywhere: this is #434's shape. listSources falls back to
    // the DB-declared volumes and scopes the name the way deploy would.
    const service = await seedService(projectId, {
      name: "data",
      image: HELPER_IMAGE,
      volumes: [VOLUME_SPEC],
      namespaceVolumes: true,
    });
    serviceId = service.id;
    volumeName = scopedVolumeName(slug, VOLUME_SPEC.split(":")[0]);

    await runtime.docker.createVolume({ Name: volumeName });
    await inVolume(
      `set -e; mkdir -p /mnt/nested; printf %s '${SENTINEL}' > /mnt/sentinel.txt; ` +
        `printf %s '${NESTED}' > /mnt/nested/deep.txt`,
    );

    destRoot = await mkdtemp(join(tmpdir(), "openship-backup-e2e-"));
    const destination = await seedBackupDestination(organizationId, {
      kind: "local",
      endpoint: destRoot,
    });
    destinationId = destination.id;
    const policy = await seedBackupPolicy(destinationId, {
      projectId,
      serviceId,
      sourceKind: "service",
      payloadKind: "volume",
      enabled: true,
    });
    policyId = policy.id;

    ctx = { userId: org.userId, organizationId } as unknown as RequestContext;
  }, 300_000);

  afterAll(async () => {
    if (volumeName) {
      await runtime.docker.getVolume(volumeName).remove({ force: true }).catch(() => {});
    }
    if (destRoot) await rm(destRoot, { recursive: true, force: true }).catch(() => {});
    await runtime?.dispose?.().catch(() => {});
    resetPlatform();
  }, 120_000);

  it("captures a volume, survives a wipe, and puts the exact bytes back", async () => {
    const before = await containerIds();

    // ── capture. `execute` is the documented worker entry point; going through
    // `enqueue` would route via the JobRunner (BullMQ when Redis answers), which
    // is a different subject and not deterministic here.
    const run = await seedBackupRun(organizationId, {
      policyId,
      destinationId,
      projectId,
      serviceId,
      sourceKind: "service",
      status: "queued",
      triggeredBy: "manual",
    });
    await backupOrchestrator.execute(run.id);

    const captured = await repos.backupRun.findById(run.id);
    expect(captured?.status, captured?.errorMessage ?? "").toBe("succeeded");
    const artifacts = (captured!.artifacts ?? []) as Array<{
      key: string;
      sha256: string | null;
      sizeBytes: number;
      payloadKind: string;
      metadata: Record<string, unknown>;
    }>;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].payloadKind).toBe("volume");
    expect(artifacts[0].metadata.volumeSource).toBe(volumeName);
    // A real digest of real bytes — this is what prepare re-derives below.
    expect(artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifacts[0].sizeBytes).toBeGreaterThan(0);

    // The bytes are on disk where the manifest says they are.
    expect(captured!.manifestKey).toBeTruthy();
    expect((await stat(join(destRoot, captured!.manifestKey!))).size).toBeGreaterThan(0);
    expect((await stat(join(destRoot, artifacts[0].key))).size).toBe(artifacts[0].sizeBytes);

    // ── destroy the data. Not a container swap — the volume itself is emptied,
    // so only the archive can bring it back.
    await inVolume("find /mnt -mindepth 1 -delete");
    expect((await inVolume("find /mnt -mindepth 1 | wc -l")).trim()).toBe("0");

    // ── restore. Prepare verifies before anything is touched; apply writes.
    const token = randomBytes(24).toString("base64url");
    const { restoreId } = await restoreOrchestrator.beginPrepare({
      runId: run.id,
      trigger: { source: "manual", userId: ctx.userId },
      confirmationToken: token,
    });

    const prepared = await waitForRestore(restoreId, "prepared");
    const prepMeta = (prepared.meta ?? {}) as Record<string, unknown>;
    // Stage 8's claim, measured against bytes a fake never touched: the archive
    // was re-hashed (not just size-checked) and the destination's own manifest
    // agreed with the recorded artifact list.
    expect(prepMeta.integrity).toBe("sha256");
    expect(prepMeta.manifest).toBe("verified");
    expect(prepared.bytesRestored).toBe(artifacts[0].sizeBytes);

    await restoreOrchestrator.apply(ctx, restoreId, token);
    const applied = await waitForRestore(restoreId, "succeeded");
    const appliedMeta = (applied.meta ?? {}) as Record<string, unknown>;
    expect(appliedMeta.destructive).toBe(true);
    // Prepare's verdict survives the terminal patch (meta is merged, not replaced).
    expect(appliedMeta.integrity).toBe("sha256");

    // ── the whole point: same tree, same bytes.
    expect((await inVolume("find /mnt -type f | sort")).trim().split(/\s+/)).toEqual(
      EXPECTED_TREE,
    );
    expect(await inVolume("cat /mnt/sentinel.txt")).toBe(SENTINEL);
    expect(await inVolume("cat /mnt/nested/deep.txt")).toBe(NESTED);

    // ── #434's leak: every helper the capture and the extract created is gone.
    // With AutoRemove the daemon could reap one before /wait answered; without
    // the `finally` reap, a throw before start() left one forever.
    const leaked = [...(await containerIds())].filter((id) => !before.has(id));
    expect(leaked).toEqual([]);
  }, 900_000);
});
