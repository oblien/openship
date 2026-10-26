/** #1444: public policy → real queue → app volume → verified restore, with no service row. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  DockerRuntime,
  initPlatform,
  resetPlatform,
  scopedVolumeName,
  setBackupCredentialSecret,
  type RecordedBackupArtifact,
} from "@repo/adapters";
import { repos, type BackupRun } from "@repo/db";
import { OpenshipClient } from "@repo/sdk/client";
import { env } from "@repo/platform/engine/config/index";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { resolvePlatformConfig } from "@repo/platform/engine/lib/platform-config";
import { getJobRunner, shutdownJobRunner } from "@repo/platform/engine/lib/job-runner/index";
import { backupOrchestrator } from "@repo/platform/engine/modules/backups/backup.orchestrator";
import { backupRoutes } from "../../src/modules/backups/backup.routes";
import { backupDestinationRoutes } from "../../src/modules/backup-destinations/destination.routes";
import { handleApiError } from "../../src/middleware/error-handler";
import { healthRoutes } from "../../src/modules/health/health.routes";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { backupE2EHarness, waitForBackup } from "../helpers/backup-e2e";
import { seedOrg, seedProject, seedDeployment, setActive } from "../helpers/seed";

const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api", backupRoutes)
  .route("/api/backup-destinations", backupDestinationRoutes);

describeDockerE2E("standalone app backup and restore through public controls", () => {
  let runtime: DockerRuntime, client: OpenshipClient;
  let projectId = "",
    organizationId = "",
    userId = "",
    policyId = "",
    destinationId = "";
  let volume = "",
    containerId = "",
    destRoot = "";
  let captured: BackupRun;
  const { waitForRestore } = backupE2EHarness(() => ({
    ctx: { userId, organizationId } as never,
    projectId,
    organizationId,
    serviceId: "",
    policyId,
    destinationId,
    destRoot,
  }));
  async function exec(command: string) {
    const process = await runtime.docker.getContainer(containerId).exec({
      Cmd: ["sh", "-ec", command],
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    const stream = await process.start({ hijack: true, stdin: false, Tty: true });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const output = Buffer.concat(chunks).toString("utf8").trim();
    expect((await process.inspect()).ExitCode, output).toBe(0);
    return output;
  }
  beforeAll(async () => {
    await requireDocker();
    setBackupCredentialSecret(env.BETTER_AUTH_SECRET);
    await initPlatform(resolvePlatformConfig());
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage("alpine:3");
    const org = await seedOrg({ ownsHost: true });
    ({ userId, organizationId } = org);
    const pat = mintPatToken();
    await repos.personalAccessToken.create({
      userId,
      organizationId,
      name: "app backup test",
      tokenPrefix: pat.tokenPrefix,
      tokenHash: pat.tokenHash,
      readOnly: false,
      scoped: false,
      expiresAt: null,
    });
    client = new OpenshipClient({
      baseUrl: "http://openship.test",
      token: pat.token,
      organizationId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    });
    const project = await seedProject(organizationId, {
      slug: `app-backup-${randomBytes(4).toString("hex")}`,
      framework: "node",
      volumes: ["data:/data"],
    });
    projectId = project.id;
    volume = scopedVolumeName(project.slug, "data");
    await runtime.docker.createVolume({ Name: volume });
    const container = await runtime.docker.createContainer({
      Image: "alpine:3",
      Cmd: ["sleep", "infinity"],
      Labels: { "openship.project": projectId },
      HostConfig: { Binds: [`${volume}:/data`] },
    });
    containerId = container.id;
    await container.start();
    const deployment = await seedDeployment(project, {
      status: "ready",
      containerId,
      imageRef: "alpine:3",
      meta: { deployTarget: "local", runtimeMode: "docker" },
    });
    await setActive(projectId, deployment.id);
    await exec(
      "printf original-data > /data/value.txt; mkdir -p /data/uploads; printf upload-data > /data/uploads/file.txt",
    );
    await mkdir(env.BACKUP_LOCAL_ROOT, { recursive: true });
    destRoot = await mkdtemp(join(env.BACKUP_LOCAL_ROOT, "project-app-"));
    destinationId = (
      await client.backupDestinations.create({
        name: "App backups",
        kind: "local",
        endpoint: destRoot,
      })
    ).id;
    policyId = (
      await client.backups.createPolicy(projectId, {
        destinationId,
        payloadKind: "auto",
        retainCount: 3,
      })
    ).id;
    await (await getJobRunner()).start({ processRun: (id) => backupOrchestrator.execute(id) });
  });

  afterAll(async () => {
    await shutdownJobRunner();
    if (containerId) await runtime.docker.getContainer(containerId).remove({ force: true });
    if (volume) await runtime.docker.getVolume(volume).remove();
    if (destRoot) await rm(destRoot, { recursive: true, force: true });
    await runtime?.dispose?.();
    resetPlatform();
  });

  it("saves a project policy and captures real app data without creating deployment services", async () => {
    const result = await client.backups.run(policyId);
    expect(result.runIds).toEqual([result.runId]);
    captured = await waitForBackup(result.runId);
    expect(captured).toMatchObject({
      sourceKind: "project",
      projectId,
      serviceId: null,
      status: "succeeded",
    });
    expect((await client.backups.getRun(result.runId)).sourceKind).toBe("project");
    expect(await repos.service.listByProject(projectId)).toEqual([]);
    const artifacts = captured.artifacts as RecordedBackupArtifact[];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].metadata).toMatchObject({ volumeSource: volume });
    expect(artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(join(destRoot, artifacts[0].key))).size).toBe(artifacts[0].sizeBytes);
    expect((await stat(join(destRoot, captured.manifestKey!))).size).toBeGreaterThan(0);
  });

  it("verifies, confirms and restores the app volume, then restarts the same app", async () => {
    await exec("rm -rf /data/uploads; printf changed > /data/value.txt");
    const prepared = await client.backups.prepareRestore(captured.id);
    expect((await waitForRestore(prepared.restoreId, "prepared")).meta).toMatchObject({
      integrity: "sha256",
      manifest: "verified",
    });
    await expect(
      client.backups.applyRestore(prepared.restoreId, { confirmationToken: "wrong-token" }),
    ).rejects.toThrow();
    expect(await exec("cat /data/value.txt")).toBe("changed");
    await client.backups.applyRestore(prepared.restoreId, {
      confirmationToken: prepared.confirmationToken,
    });
    await waitForRestore(prepared.restoreId, "succeeded");
    expect((await runtime.docker.getContainer(containerId).inspect()).State.Running).toBe(true);
    expect(await exec("cat /data/value.txt")).toBe("original-data");
    expect(await exec("cat /data/uploads/file.txt")).toBe("upload-data");
    expect(await repos.service.listByProject(projectId)).toEqual([]);
  });

  it("does not reinterpret a deleted service's backup as an app backup", async () => {
    const { db, schema, eq } = await import("@repo/db");
    // Simulate a historical service FK cleared by ON DELETE SET NULL.
    await db
      .update(schema.backupRun)
      .set({ sourceKind: "service" })
      .where(eq(schema.backupRun.id, captured.id));
    const attempt = await client.backups.prepareRestore(captured.id);
    const failed = await waitForRestore(attempt.restoreId, "failed");
    expect(failed.errorMessage).toContain("Source run has no serviceId");
    expect(await exec("cat /data/value.txt")).toBe("original-data");
  });
});
