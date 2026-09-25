/** Release gate: public API/SDK → real queue → Docker → separate SFTP server → restore. */
import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DockerRuntime,
  initPlatform,
  resetPlatform,
  setBackupCredentialSecret,
  type RecordedBackupArtifact,
} from "@repo/adapters";
import { incrementalBackupStorage, backupArtifactObjects } from "@repo/core";
import { getFreePort } from "@repo/core/ports";
import { repos, type BackupRun } from "@repo/db";
import type { BackupRun as RunSnapshot, BackupRestore as RestoreSnapshot } from "@repo/contracts";
import { OpenshipClient } from "@repo/sdk/client";
import { env } from "@repo/platform/engine/config/index";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { resolvePlatformConfig } from "@repo/platform/engine/lib/platform-config";
import {
  getJobRunner,
  shutdownJobRunner,
  setJobRunnerForTests,
} from "@repo/platform/engine/lib/job-runner/index";
import { InProcessJobRunner } from "@repo/platform/engine/lib/job-runner/in-process";
import { backupOrchestrator } from "@repo/platform/engine/modules/backups/backup.orchestrator";
import { backupRunBus } from "@repo/platform/engine/modules/backups/backup.sse";
import { restoreRunBus } from "@repo/platform/engine/modules/backups/restore.sse";
import { prunePolicy } from "@repo/platform/engine/modules/backups/retention-prune";
import { backupRoutes } from "../../src/modules/backups/backup.routes";
import { backupDestinationRoutes } from "../../src/modules/backup-destinations/destination.routes";
import { healthRoutes } from "../../src/modules/health/health.routes";
import { handleApiError } from "../../src/middleware/error-handler";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { backupE2EHarness, waitForBackup } from "../helpers/backup-e2e";
import {
  seedOrg,
  seedProject,
  seedDeployment,
  seedService,
  seedServiceDeployment,
  setActive,
} from "../helpers/seed";

const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api", backupRoutes)
  .route("/api/backup-destinations", backupDestinationRoutes);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDockerE2E("backup lifecycle through the public controls", () => {
  let runtime: DockerRuntime;
  let client: OpenshipClient;
  let organizationId = "",
    userId = "",
    projectId = "",
    serviceId = "",
    policyId = "";
  let destinationId = "",
    sourceContainer = "",
    sftpContainer = "",
    destRoot = "";
  let sshPort = 0;
  const storageImage = `openship-backup-test:${randomBytes(6).toString("hex")}`;
  const containers: string[] = [],
    volumes: string[] = [],
    localRoots: string[] = [];
  const { waitForRestore } = backupE2EHarness(() => ({
    ctx: { userId, organizationId } as never,
    organizationId,
    projectId,
    serviceId,
    policyId,
    destinationId,
    destRoot,
  }));

  async function authenticated(org: { userId: string; organizationId: string }, readOnly = false) {
    const pat = mintPatToken();
    await repos.personalAccessToken.create({
      userId: org.userId,
      organizationId: org.organizationId,
      name: "backup release test",
      tokenPrefix: pat.tokenPrefix,
      tokenHash: pat.tokenHash,
      readOnly,
      scoped: false,
      expiresAt: null,
    });
    return new OpenshipClient({
      baseUrl: "http://openship.test",
      token: pat.token,
      organizationId: org.organizationId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    });
  }
  async function exec(containerId: string, command: string) {
    const commandHandle = await runtime.docker.getContainer(containerId).exec({
      Cmd: ["sh", "-ec", command],
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    const stream = await commandHandle.start({ hijack: true, stdin: false, Tty: true });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    const output = Buffer.concat(chunks).toString("utf8").replace(/\r/g, "").trim();
    if ((await commandHandle.inspect()).ExitCode !== 0)
      throw new Error(`Fixture command failed: ${output}`);
    return output;
  }
  async function createVolume() {
    const name = `openship-backup-release-${randomBytes(6).toString("hex")}`;
    await runtime.docker.createVolume({ Name: name });
    volumes.push(name);
    return name;
  }
  async function localDestination(name: string) {
    const root = await mkdtemp(join(env.BACKUP_LOCAL_ROOT, "lifecycle-"));
    localRoots.push(root);
    const destination = await client.backupDestinations.create({
      name,
      kind: "local",
      endpoint: root,
    });
    expect(await client.backupDestinations.preflight(destination.id)).toMatchObject({ ok: true });
    return { root, destination };
  }
  async function run() {
    const accepted = await client.backups.run(policyId);
    expect(accepted.runIds).toEqual([accepted.runId]);
    const captured = await waitForBackup(accepted.runId);
    expect((await client.backups.getRun(captured.id)).status).toBe("succeeded");
    return captured;
  }
  const artifacts = (row: BackupRun) => row.artifacts as RecordedBackupArtifact[];
  async function restore(runId: string) {
    const prepared = await client.backups.prepareRestore(runId);
    expect((await waitForRestore(prepared.restoreId, "prepared")).meta).toMatchObject({
      integrity: "sha256",
      manifest: "verified",
    });
    await client.backups.applyRestore(prepared.restoreId, {
      confirmationToken: prepared.confirmationToken,
    });
    await waitForRestore(prepared.restoreId, "succeeded");
    expect((await runtime.docker.getContainer(sourceContainer).inspect()).State.Running).toBe(true);
  }

  beforeAll(async () => {
    await requireDocker();
    // Same resolved encryption key injected by the API entrypoint at boot.
    setBackupCredentialSecret(env.BETTER_AUTH_SECRET);
    await initPlatform(resolvePlatformConfig());
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage("alpine:3");
    const build = await runtime.docker.buildImage(
      {
        context: fileURLToPath(new URL("../fixtures/backup-sftp", import.meta.url)),
        src: ["Dockerfile"],
      },
      { t: storageImage },
    );
    await new Promise<void>((resolve, reject) =>
      runtime.docker.modem.followProgress(build, (error) => (error ? reject(error) : resolve())),
    );
    const org = await seedOrg({ ownsHost: true });
    ({ organizationId, userId } = org);
    client = await authenticated(org);
    const project = await seedProject(organizationId, {
      slug: `backup-release-${randomBytes(4).toString("hex")}`,
    });
    projectId = project.id;
    const deployment = await seedDeployment(project, {
      meta: { deployTarget: "local", runtimeMode: "docker" } as never,
    });
    await setActive(projectId, deployment.id);
    const volume = await createVolume();
    const service = await seedService(projectId, {
      name: "app",
      image: "alpine:3",
      volumes: [`${volume}:/data`],
      namespaceVolumes: false,
    });
    serviceId = service.id;
    const source = await runtime.docker.createContainer({
      Image: "alpine:3",
      Cmd: ["sleep", "infinity"],
      HostConfig: { Binds: [`${volume}:/data`] },
    });
    sourceContainer = source.id;
    containers.push(source.id);
    await source.start();
    await seedServiceDeployment(
      deployment.id,
      { id: serviceId, name: "app" },
      { containerId: source.id },
    );
    await exec(
      source.id,
      "dd if=/dev/urandom of=/data/blob.bin bs=1048576 count=10 2>/dev/null; printf original > /data/value.txt",
    );
    const storageVolume = await createVolume();
    // A VM daemon cannot see ports already used on the control-plane host.
    // Choose a host port here so its automatic forwarding cannot hit an editor
    // tunnel or another local service instead of the test SSH server.
    const storagePort = await getFreePort();
    // The destination is a separate SSH server with its own volume. No backup
    // adapter, producer, auth handler, queue, or repository is mocked.
    const storage = await runtime.docker.createContainer({
      Image: storageImage,
      ExposedPorts: { "2222/tcp": {} },
      HostConfig: {
        Binds: [`${storageVolume}:/home/backup/backups`],
        PortBindings: { "2222/tcp": [{ HostIp: "127.0.0.1", HostPort: String(storagePort) }] },
      },
    });
    sftpContainer = storage.id;
    containers.push(storage.id);
    await storage.start();
    sshPort = Number((await storage.inspect()).NetworkSettings.Ports["2222/tcp"]![0].HostPort);
    const input = {
      name: "Remote release backups",
      kind: "sftp" as const,
      sshHost: "127.0.0.1",
      sshPort,
      sshUser: "backup",
      sftpPassword: "release-test-password",
      pathPrefix: "/home/backup/backups",
    };
    const deadline = Date.now() + 120_000;
    let ready = false;
    let lastReason: string | undefined;
    while (Date.now() < deadline) {
      const result = await client.backupDestinations.preflightDraft(input);
      if (result.ok) {
        ready = true;
        break;
      }
      lastReason = result.reason;
      await delay(1_000);
    }
    if (!ready) {
      const logs = await storage.logs({ stdout: true, stderr: true, tail: 30 });
      throw new Error(`Test SFTP server unavailable: ${lastReason}\n${logs.toString()}`);
    }
    destinationId = (await client.backupDestinations.create(input)).id;
    await mkdir(env.BACKUP_LOCAL_ROOT, { recursive: true });
    const policy = await client.backups.createPolicy(projectId, {
      serviceId,
      destinationId,
      payloadKind: "volume",
      payloadConfig: { incremental: true },
      retainCount: 2,
    });
    policyId = policy.id;
    const runner = await getJobRunner();
    await runner.start({ processRun: (id) => backupOrchestrator.execute(id) });
  }, 300_000);

  beforeEach(async () => {
    // Each scenario starts from a complete source, even if the preceding
    // scenario failed after deliberately deleting its test data.
    await exec(
      sourceContainer,
      "dd if=/dev/urandom of=/data/blob.bin bs=1048576 count=10 2>/dev/null; printf original > /data/value.txt; rm -f /data/extra.txt /data/backup.lock",
    );
    await client.backups.updatePolicy(policyId, {
      destinationId,
      payloadConfig: { incremental: true },
      retainCount: 2,
      cronExpression: null,
      preHook: null,
      postHook: null,
    });
  });

  afterAll(async () => {
    await shutdownJobRunner(60_000);
    for (const id of containers.reverse())
      await runtime?.docker
        .getContainer(id)
        .remove({ force: true })
        .catch(() => {});
    for (const name of volumes)
      await runtime?.docker
        .getVolume(name)
        .remove({ force: true })
        .catch(() => {});
    await runtime?.docker
      .getImage(storageImage)
      .remove({ force: true })
      .catch(() => {});
    for (const root of localRoots) await rm(root, { recursive: true, force: true });
    await runtime?.dispose();
    resetPlatform();
  }, 120_000);

  it("captures to another server, reuses unchanged blocks, prunes the parent, and restores exact data", async () => {
    const expectedHash = await exec(sourceContainer, "sha256sum /data/blob.bin");
    const first = await run();
    const second = await run();
    const before = incrementalBackupStorage(artifacts(first)[0])!;
    const after = incrementalBackupStorage(artifacts(second)[0])!;
    expect(after.chunks.map((chunk) => chunk.key)).toEqual(before.chunks.map((chunk) => chunk.key));
    expect(after.uploadedBytes).toBeLessThan(before.uploadedBytes / 100);
    await exec(sourceContainer, "printf latest > /data/value.txt");
    const latest = await run();
    await expect
      .poll(async () => (await repos.backupRun.findById(first.id))?.deletedAt, { timeout: 20_000 })
      .not.toBeNull();
    await exec(sftpContainer, `test ! -e /home/backup/backups/${first.manifestKey}`);
    const expectedObjects = new Map<string, number>();
    for (const row of [second, latest])
      for (const artifact of artifacts(row))
        for (const [key, size] of backupArtifactObjects(artifact)) expectedObjects.set(key, size);
    expect(
      (await client.backupDestinations.list()).find(
        (destination) => destination.id === destinationId,
      )?.stats?.storedBytes,
    ).toBe([...expectedObjects.values()].reduce((sum, size) => sum + size, 0));
    await exec(
      sourceContainer,
      "rm -f /data/blob.bin; printf damaged > /data/value.txt; printf obsolete > /data/extra.txt",
    );
    await restore(latest.id);
    expect(await exec(sourceContainer, "sha256sum /data/blob.bin")).toBe(expectedHash);
    expect(await exec(sourceContainer, "cat /data/value.txt; test ! -e /data/extra.txt")).toBe(
      "latest",
    );
    const status = await client.backups.getRun(latest.id);
    expect(JSON.stringify(status)).not.toContain("release-test-password");
  });

  it("protects restore points from retention while prepared, then resumes cleanup after cancellation", async () => {
    const point = await run();
    const pending = await client.backups.prepareRestore(point.id);
    await waitForRestore(pending.restoreId, "prepared");
    await client.backups.updatePolicy(policyId, { retainCount: 1 });
    await run();
    await prunePolicy((await repos.backupPolicy.findById(policyId))!);
    expect((await repos.backupRun.findById(point.id))?.deletedAt).toBeNull();
    await client.backups.cancelRestore(pending.restoreId);
    await prunePolicy((await repos.backupPolicy.findById(policyId))!);
    expect((await repos.backupRun.findById(point.id))?.deletedAt).not.toBeNull();
  });

  it("streams saved backup and restore progress through HTTP when worker notifications are lost", async () => {
    // The real worker and storage still run. Only its process-local notifications
    // are dropped, as when an API connection is served by another process.
    const backupEvents = vi.spyOn(backupRunBus, "publish").mockImplementation(() => {});
    const restoreEvents = vi.spyOn(restoreRunBus, "publish").mockImplementation(() => {});
    try {
      const accepted = await client.backups.run(policyId);
      const snapshots: RunSnapshot[] = [];
      const events: string[] = [];
      for await (const frame of client.backups.streamRun(accepted.runId, { signal: AbortSignal.timeout(120_000) })) {
        const event = JSON.parse(frame.data);
        events.push(event.type);
        if (event.type === "snapshot") snapshots.push(event.run);
      }
      const saved = await client.backups.getRun(accepted.runId);
      expect(events.at(-1)).toBe("complete");
      expect(snapshots.at(-1)).toMatchObject({
        status: "succeeded", finishedAt: saved.finishedAt, bytesTransferred: saved.bytesTransferred,
      });
      expect(saved.finishedAt).toBeTruthy();
      expect(saved.bytesTransferred).toBeGreaterThan(0);

      await exec(sourceContainer, "printf changed > /data/value.txt");
      const prepared = await client.backups.prepareRestore(accepted.runId);
      const restores: RestoreSnapshot[] = [];
      let applied = false;
      let completed = false;
      for await (const frame of client.backups.streamRestore(prepared.restoreId, { signal: AbortSignal.timeout(120_000) })) {
        const event = JSON.parse(frame.data);
        if (event.type === "snapshot") {
          restores.push(event.restore);
          if (event.restore.status === "prepared" && !applied) {
            applied = true;
            await client.backups.applyRestore(prepared.restoreId, { confirmationToken: prepared.confirmationToken });
          }
        }
        if (event.type === "complete") completed = true;
      }
      const restored = await client.backups.getRestore(prepared.restoreId);
      expect(applied).toBe(true);
      expect(completed).toBe(true);
      expect(restores.at(-1)).toMatchObject({
        status: "succeeded", finishedAt: restored.finishedAt, bytesRestored: restored.bytesRestored,
      });
      expect(restored.finishedAt).toBeTruthy();
      expect(await exec(sourceContainer, "cat /data/value.txt")).toBe("original");
    } finally {
      backupEvents.mockRestore();
      restoreEvents.mockRestore();
    }
  });

  it("keeps a conflicting restore prepared until the current writer finishes, then restores it exactly", async () => {
    await exec(sourceContainer, "printf first > /data/value.txt");
    const first = await client.backups.prepareRestore((await run()).id);
    await waitForRestore(first.restoreId, "prepared");
    await exec(sourceContainer, "printf second > /data/value.txt");
    const second = await client.backups.prepareRestore((await run()).id);
    await waitForRestore(second.restoreId, "prepared");

    // Hold real storage I/O so the first apply cannot complete before the
    // conflicting public request. No mocked worker or destructive command.
    const storage = runtime.docker.getContainer(sftpContainer);
    await storage.pause();
    let started = false;
    try {
      await client.backups.applyRestore(first.restoreId, {
        confirmationToken: first.confirmationToken,
      });
      started = true;
      await expect(
        client.backups.applyRestore(second.restoreId, {
          confirmationToken: second.confirmationToken,
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: "RESTORE_TARGET_BUSY",
        message: expect.stringMatching(/still prepared.*retry/i),
      });
      expect((await client.backups.getRestore(second.restoreId)).status).toBe("prepared");
    } finally {
      await storage.unpause();
      if (started) await waitForRestore(first.restoreId, "succeeded");
    }
    expect(await exec(sourceContainer, "cat /data/value.txt")).toBe("first");
    await client.backups.applyRestore(second.restoreId, {
      confirmationToken: second.confirmationToken,
    });
    await waitForRestore(second.restoreId, "succeeded");
    expect(await exec(sourceContainer, "cat /data/value.txt")).toBe("second");
  });

  it("enforces protection, and refuses corrupt data before touching the service", async () => {
    const point = await run();
    await client.backups.protectRun(point.id);
    await run();
    await prunePolicy((await repos.backupPolicy.findById(policyId))!);
    expect((await repos.backupRun.findById(point.id))?.deletedAt).toBeNull();
    const chunk = incrementalBackupStorage(artifacts(point)[0])!.chunks[0];
    await exec(sftpContainer, `printf damaged > /home/backup/backups/${chunk.key}`);
    const before = await exec(sourceContainer, "sha256sum /data/blob.bin /data/value.txt");
    const prepared = await client.backups.prepareRestore(point.id);
    const failed = await waitForRestore(prepared.restoreId, "failed");
    expect(failed.errorMessage).toMatch(/block|size|integrity/i);
    expect(await exec(sourceContainer, "sha256sum /data/blob.bin /data/value.txt")).toBe(before);
    expect((await runtime.docker.getContainer(sourceContainer).inspect()).State.Running).toBe(true);
    await client.backups.protectRun(point.id, { protected: false });
    // A fresh capture repairs the missing/corrupt block from the live source.
    await run();
  });

  it("keeps queued backups at their original destination and keeps old storage reachable", async () => {
    await shutdownJobRunner(60_000);
    setJobRunnerForTests(new InProcessJobRunner());
    const queued = await client.backups.run(policyId);
    expect((await client.backups.getRun(queued.runId)).status).toBe("queued");
    const local = await localDestination("Next destination");
    destRoot = local.root;
    await client.backups.updatePolicy(policyId, {
      destinationId: local.destination.id,
      retainCount: 2,
    });
    await expect(
      client.backupDestinations.update(destinationId, { pathPrefix: "/somewhere-else" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(client.backupDestinations.remove(destinationId)).rejects.toThrow(
      /backup|retained/i,
    );
    await (await getJobRunner()).start({ processRun: (id) => backupOrchestrator.execute(id) });
    const captured = await waitForBackup(queued.runId);
    expect(captured.destinationId).toBe(destinationId);
    await restore(captured.id);
    const firstLocal = await run();
    expect(firstLocal.destinationId).toBe(local.destination.id);
    expect(await stat(join(local.root, firstLocal.manifestKey!))).toBeTruthy();
    await run();
    await expect
      .poll(async () => (await repos.backupRun.findById(captured.id))?.deletedAt, {
        timeout: 20_000,
      })
      .not.toBeNull();
    await exec(sftpContainer, `test ! -e /home/backup/backups/${captured.manifestKey}`);
  });

  it("honors saved schedules, pauses them, and surfaces source errors with cleanup hooks", async () => {
    await client.backups.updatePolicy(policyId, { cronExpression: "*/2 * * * * *" });
    let scheduled: BackupRun | undefined;
    await expect
      .poll(
        async () => {
          scheduled = (
            await repos.backupRun.listByOrganization(organizationId, { projectId })
          ).find((row) => row.triggeredBy === "cron");
          return scheduled?.id;
        },
        { timeout: 15_000, interval: 200 },
      )
      .toBeTruthy();
    await client.backups.updatePolicy(policyId, { cronExpression: null });
    await waitForBackup(scheduled!.id);
    const count = (await client.backups.listRuns(projectId)).length;
    await delay(2_500);
    expect((await client.backups.listRuns(projectId)).length).toBe(count);
    await client.backups.updatePolicy(policyId, {
      payloadConfig: { sourceIds: [volumes[0], "missing-volume"] },
      preHook: "touch /data/backup.lock",
      postHook: "rm -f /data/backup.lock",
    });
    const accepted = await client.backups.run(policyId);
    const failed = await waitForBackup(accepted.runId, "failed");
    expect(failed.errorMessage).toMatch(/missing-volume/);
    expect(failed.artifacts).toEqual([]);
    expect(failed.hookLog).toContain("post-hook");
    await exec(sourceContainer, "test ! -e /data/backup.lock");
    await client.backups.updatePolicy(policyId, {
      payloadConfig: { incremental: true },
      preHook: null,
      postHook: null,
    });
    await run();
  });

  it("resumes a quiesced service and reaps its helper when storage rejects the upload", async () => {
    const blocked = await localDestination("Unavailable storage path");
    await writeFile(join(blocked.root, "openship"), "not a directory");
    const before = new Set(
      (await runtime.docker.listContainers({ all: true })).map((container) => container.Id),
    );
    await client.backups.updatePolicy(policyId, {
      destinationId: blocked.destination.id,
      payloadConfig: { compression: "none", quiesce: true },
      preHook: "touch /data/backup.lock",
      postHook: "rm -f /data/backup.lock",
    });
    const accepted = await client.backups.run(policyId);
    const failed = await waitForBackup(accepted.runId, "failed");
    expect(failed.errorMessage).toMatch(/ENOTDIR|not a directory/);
    expect(failed.artifacts).toEqual([]);
    expect((await runtime.docker.getContainer(sourceContainer).inspect()).State).toMatchObject({
      Running: true,
      Paused: false,
    });
    await exec(sourceContainer, "test ! -e /data/backup.lock");
    await expect
      .poll(
        async () =>
          (await runtime.docker.listContainers({ all: true })).filter(
            (container) => !before.has(container.Id),
          ),
        { timeout: 5_000 },
      )
      .toEqual([]);
  });

  it("serializes incremental capture with pruning and executes duplicate worker deliveries once", async () => {
    const first = await run();
    await run();
    await client.backups.updatePolicy(policyId, {
      retainCount: 1,
      preHook:
        "touch /data/capture.started; while [ ! -f /data/capture.release ]; do sleep 0.1; done",
      postHook: "printf x >> /data/capture.executions",
    });
    const accepted = await client.backups.run(policyId);
    await expect
      .poll(() => exec(sourceContainer, "if [ -f /data/capture.started ]; then printf ready; fi"), {
        timeout: 10_000,
      })
      .toBe("ready");
    let pruned = false;
    const pruning = prunePolicy((await repos.backupPolicy.findById(policyId))!).then((result) => {
      pruned = true;
      return result;
    });
    const duplicate = backupOrchestrator.execute(accepted.runId);
    try {
      const active = await client.backups.listRuns(projectId, { active: true });
      expect(active.some(row => row.id === accepted.runId)).toBe(true);
      expect(active.some(row => row.id === first.id)).toBe(false);
      await delay(100);
      expect(pruned).toBe(false);
    } finally {
      await exec(sourceContainer, "touch /data/capture.release");
    }
    const captured = await waitForBackup(accepted.runId);
    await Promise.all([pruning, duplicate]);
    expect((await client.backups.listRuns(projectId, { active: true })).some(row => row.id === captured.id)).toBe(false);
    expect((await client.backups.listRuns(projectId, { active: false })).some(row => row.id === captured.id)).toBe(true);
    expect(await exec(sourceContainer, "cat /data/capture.executions")).toBe("x");
    expect((await repos.backupRun.findById(first.id))?.deletedAt).not.toBeNull();
    const hash = await exec(sourceContainer, "sha256sum /data/blob.bin");
    await exec(sourceContainer, "rm /data/blob.bin");
    await restore(captured.id);
    expect(await exec(sourceContainer, "sha256sum /data/blob.bin")).toBe(hash);
  });

  it("rejects foreign and read-only writes, and reports all project fan-out runs", async () => {
    const foreign = await authenticated(await seedOrg());
    await expect(foreign.backups.run(policyId)).rejects.toMatchObject({ status: 404 });
    const reader = await authenticated({ userId, organizationId }, true);
    await expect(reader.backups.run(policyId)).rejects.toMatchObject({ status: 403 });
    const secondary = await seedService(projectId, {
      name: "other",
      image: "alpine:3",
      volumes: [`${volumes[0]}:/data`],
      namespaceVolumes: false,
    });
    await seedService(projectId, { name: "stateless", image: "alpine:3" });
    const destination = await localDestination("Project snapshots");
    const defaults = await client.backups.createPolicy(projectId, {
      destinationId: destination.destination.id,
      payloadKind: "auto",
    });
    const selected = await client.backups.run(defaults.id, { serviceId: secondary.id });
    expect((await waitForBackup(selected.runId)).serviceId).toBe(secondary.id);
    const all = await client.backups.run(defaults.id);
    expect(all.runIds).toHaveLength(2);
    const runs = await Promise.all(all.runIds!.map((id) => waitForBackup(id)));
    expect(new Set(runs.map((row) => row.serviceId))).toEqual(new Set([serviceId, secondary.id]));
    expect(new Set(runs.map((row) => row.batchId)).size).toBe(1);
    const history = await client.backups.listRuns(projectId, { limit: 1000 });
    const paged: string[] = [];
    let before: string | undefined;
    do {
      const page = await client.backups.listRuns(projectId, { limit: 2, ...(before && { before }) });
      paged.push(...page.map(row => row.id));
      before = page.length === 2 ? page.at(-1)!.id : undefined;
      expect(paged.length).toBeLessThanOrEqual(history.length);
    } while (before);
    expect(paged).toEqual(history.map(row => row.id));
    await expect(
      client.backups.run(defaults.id, { serviceId: "foreign-service" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
