import { describe, expect, it, vi } from "vitest";
import { repos } from "@repo/db";
import { BackupOrchestrator } from "@repo/platform/engine/modules/backups/backup.orchestrator";
import {
  projectBackupVolumes,
  resolveProjectBackupSource,
} from "@repo/platform/engine/modules/backups/project-source";
import {
  seedOrg,
  seedProject,
  seedService,
  seedDeployment,
  setActive,
  seedBackupDestination,
  seedBackupPolicy,
  seedBackupRun,
} from "../../helpers/seed";

const queued = vi.hoisted(() => vi.fn());
vi.mock("@repo/platform/engine/lib/job-runner/index", () => ({
  getJobRunner: async () => ({ enqueueRun: queued }),
}));

async function fixture() {
  const org = await seedOrg();
  const project = await seedProject(org.organizationId, {
    framework: "node",
    volumes: ["uploads", "data:/app/data"],
  });
  const deployment = await seedDeployment(project, {
    status: "ready",
    containerId: "owned-app-container",
    imageRef: "my-app:release",
    meta: { deployTarget: "local", runtimeMode: "docker" },
  });
  await setActive(project.id, deployment.id);
  const destination = await seedBackupDestination(org.organizationId);
  const policy = await seedBackupPolicy(destination.id, {
    projectId: project.id,
    serviceId: null,
    enabled: true,
    payloadKind: "auto",
  });
  return { org, project, deployment, destination, policy };
}

describe("standalone application backup targets (#1444)", () => {
  it.each(["manual", "cron", "webhook", "pre_deploy"] as const)(
    "admits a durable app run through the shared %s trigger",
    async (source) => {
      const f = await fixture();
      const result = await new BackupOrchestrator().enqueue({
        policyId: f.policy.id,
        trigger: { source, userId: f.org.userId },
      });
      expect(result.runIds).toEqual([result.runId]);
      expect(await repos.backupRun.findById(result.runId)).toMatchObject({
        sourceKind: "project",
        projectId: f.project.id,
        serviceId: null,
        status: "queued",
        triggeredBy: source,
        organizationId: f.org.organizationId,
        batchId: expect.stringMatching(/^bkb_/),
      });
      expect(queued).toHaveBeenCalledWith(result.runId);
      expect(await repos.service.listByProject(f.project.id)).toEqual([]);
      expect((await repos.backupPolicy.findById(f.policy.id))?.sourceKind).toBe("service");
    },
  );

  it("uses deployment volume normalization and project-scoped names without creating an app row", async () => {
    const f = await fixture();
    const source = await resolveProjectBackupSource(f.project.id, f.org.organizationId);
    expect(source.handle).toMatchObject({
      id: f.project.id,
      projectId: f.project.id,
      containerId: "owned-app-container",
      volumes: ["uploads:/app/uploads", "data:/app/data"],
      namespaceVolumes: true,
    });
    expect(
      projectBackupVolumes({ ...f.project, framework: "laravel", volumes: null }, []).length,
    ).toBeGreaterThan(0);
    expect(projectBackupVolumes({ ...f.project, framework: "laravel", volumes: [] }, [])).toEqual(
      [],
    );
    expect(await repos.service.listByProject(f.project.id)).toEqual([]);
  });

  it("refuses foreign projects and removed targets before resolving a runtime", async () => {
    const f = await fixture(),
      other = await seedOrg();
    await expect(resolveProjectBackupSource(f.project.id, other.organizationId)).rejects.toThrow();
    await expect(resolveProjectBackupSource(null, f.org.organizationId)).rejects.toThrow(
      /no longer exists/,
    );
    await repos.project.update(f.project.id, { deletionInProgress: true });
    await expect(resolveProjectBackupSource(f.project.id, f.org.organizationId)).rejects.toThrow(
      /being deleted/,
    );
  });

  it("does not redirect an app backup to a service added after it was queued", async () => {
    const f = await fixture();
    await new BackupOrchestrator().enqueue({
      policyId: f.policy.id,
      trigger: { source: "cron", userId: f.org.userId },
    });
    await seedService(f.project.id, { name: "database", image: "postgres:16", enabled: false });
    await expect(resolveProjectBackupSource(f.project.id, f.org.organizationId)).rejects.toThrow(
      /configuration has changed/,
    );
    await expect(
      new BackupOrchestrator().enqueue({
        policyId: f.policy.id,
        trigger: { source: "cron", userId: f.org.userId },
      }),
    ).rejects.toThrow(/no services/);
  });

  it("keeps normal service fan-out and refuses stateless/undeployed app targets", async () => {
    const f = await fixture();
    const service = await seedService(f.project.id, {
      name: "db",
      image: "postgres:16",
      enabled: true,
    });
    const result = await new BackupOrchestrator().enqueue({
      policyId: f.policy.id,
      trigger: { source: "cron", userId: f.org.userId },
    });
    expect(result.runIds).toHaveLength(1);
    expect(await repos.backupRun.findById(result.runId)).toMatchObject({
      sourceKind: "service",
      serviceId: service.id,
    });
    const empty = await fixture();
    await repos.project.update(empty.project.id, { volumes: [] });
    await expect(
      new BackupOrchestrator().enqueue({
        policyId: empty.policy.id,
        trigger: { source: "cron", userId: empty.org.userId },
      }),
    ).rejects.toThrow(/no services/);
    await repos.project.update(empty.project.id, {
      volumes: ["uploads"],
      activeDeploymentId: null,
    });
    await expect(
      resolveProjectBackupSource(empty.project.id, empty.org.organizationId),
    ).rejects.toThrow(/Deploy the app/);
  });

  it("never reads a former multi-service deployment as the standalone app", async () => {
    const f = await fixture();
    const stack = await seedDeployment(f.project, { status: "ready", containerId: "compose" });
    await setActive(f.project.id, stack.id);
    await expect(resolveProjectBackupSource(f.project.id, f.org.organizationId)).rejects.toThrow(
      /not a standalone/,
    );
  });

  it("isolates incremental history from deleted service runs with a null service id", async () => {
    const f = await fixture();
    const common = {
      policyId: f.policy.id,
      destinationId: f.destination.id,
      projectId: f.project.id,
      serviceId: null,
    };
    const app = await seedBackupRun(f.org.organizationId, {
      ...common,
      sourceKind: "project",
      finishedAt: new Date(1000),
    });
    const orphan = await seedBackupRun(f.org.organizationId, {
      ...common,
      sourceKind: "service",
      finishedAt: new Date(2000),
    });
    const args = [f.policy.id, f.destination.id, null, null] as const;
    expect((await repos.backupRun.latestSucceededForSource(...args, "project"))?.id).toBe(app.id);
    expect((await repos.backupRun.latestSucceededForSource(...args, "service"))?.id).toBe(
      orphan.id,
    );
    expect(
      (await repos.backupRun.recentSucceededForSource(...args, "project")).map((row) => row.id),
    ).toEqual([app.id]);
  });
});
