import { afterEach, describe, expect, it, vi } from "vitest";
import { repos } from "@repo/db";
import type { RuntimeAdapter } from "@repo/adapters";
import {
  seedDeployment,
  seedOrg,
  seedProject,
  seedService,
  seedServiceDeployment,
} from "../../helpers/seed";

vi.mock("@repo/platform/engine/lib/notification-dispatcher", () => ({
  notification: { emit: vi.fn() },
}));
vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({ audit: { recordAsync: vi.fn() } }));
vi.mock("@repo/platform/engine/lib/favicon-detector", () => ({ detectAndStoreFavicon: vi.fn() }));
vi.mock("@repo/platform/engine/modules/mail/webmail/webmail-install.service", () => ({
  onWebmailDeployed: vi.fn(),
}));
const {
  beginBuildTiming,
  completeBuildTiming,
  finishServiceDeploymentTimings,
  onCancelled,
  onNoChanges,
  onReconciling,
  onSuccess,
  reportPipelineError,
} = await import("@repo/platform/engine/modules/deployments/deployment-lifecycle");
import type { LifecycleContext } from "@repo/platform/engine/modules/deployments/deployment-lifecycle";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function attempt(): Promise<LifecycleContext> {
  const org = await seedOrg();
  const project = await seedProject(org.organizationId);
  const dep = await seedDeployment(project, { status: "building" });
  const session = await repos.deployment.createBuildSession({
    deploymentId: dep.id,
    projectId: project.id,
    status: "building",
  });
  return {
    dep,
    project,
    buildSessionId: session.id,
    provisioned: {},
    persistLogs: () => [],
    logger: { log: vi.fn() },
  };
}

async function expectDuration(ctx: LifecycleContext, durationMs: number | null) {
  expect((await repos.deployment.findById(ctx.dep.id))?.buildDurationMs).toBe(durationMs);
  expect((await repos.deployment.findBuildSessionByDeploymentId(ctx.dep.id))?.durationMs).toBe(
    durationMs,
  );
}

describe("build timing through terminal hooks and real storage", () => {
  it.each([12345, 0])(
    "preserves a saved duration of %s after a late pipeline failure with a stale snapshot",
    async (durationMs) => {
      const ctx = await attempt();
      expect(ctx.dep.buildDurationMs).toBeNull();
      await repos.deployment.updateStatus(ctx.dep.id, "deploying", { buildDurationMs: durationMs });
      await reportPipelineError(ctx, "routing transport failed", ctx.logger!);
      expect((await repos.deployment.findById(ctx.dep.id))?.status).toBe("failed");
      await expectDuration(ctx, durationMs);
    },
  );

  it("keeps a failure before build timing unknown", async () => {
    const ctx = await attempt();
    await reportPipelineError(ctx, "server connection unavailable", ctx.logger!);
    await expectDuration(ctx, null);
  });

  it("measures a thrown build before artifact cleanup and freezes it for later failures", async () => {
    const ctx = await attempt();
    let clock = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    beginBuildTiming(ctx);
    ctx.provisioned.imageRef = "/tmp/disposable-build";
    ctx.runtime = {
      destroy: vi.fn(async () => {
        clock = 90000;
      }),
    } as unknown as RuntimeAdapter;
    clock = 900;
    await reportPipelineError(ctx, "build worker disconnected", ctx.logger!);
    expect(ctx.runtime.destroy).toHaveBeenCalledOnce();
    await expectDuration(ctx, 800);
    expect(completeBuildTiming(ctx)).toBe(800);
  });

  it("retains the adapter measurement across deploy time instead of measuring the whole session", async () => {
    const ctx = await attempt();
    let clock = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    beginBuildTiming(ctx);
    clock = 1500;
    completeBuildTiming(ctx, 1234);
    clock = 90000;
    await reportPipelineError(ctx, "release verification failed", ctx.logger!);
    await expectDuration(ctx, 1234);
  });

  it("records an explicitly skipped build as zero", async () => {
    const ctx = await attempt();
    completeBuildTiming(ctx, 0);
    await reportPipelineError(ctx, "prebuilt image pull failed", ctx.logger!);
    await expectDuration(ctx, 0);
  });

  it.each(["success", "no_changes", "reconciling"] as const)(
    "does not invent a zero for %s with no build measurement",
    async (outcome) => {
      const ctx = await attempt();
      if (outcome === "success") await onSuccess(ctx, { containerId: "already-created" });
      else if (outcome === "no_changes") await onNoChanges(ctx, {});
      else await onReconciling(ctx, {});
      await expectDuration(ctx, null);
    },
  );

  it.each(["failure", "cancellation", "early abort"] as const)(
    "preserves service timings through %s and cleanup without rewriting service outcomes",
    async (outcome) => {
      const ctx = await attempt();
      const finish = new Date("2026-10-20T00:00:10Z");
      const started = new Date(finish.getTime() - 4321);
      const running = await seedService(ctx.project.id, { name: "building" });
      const completed = await seedService(ctx.project.id, { name: "completed" });
      const untouched = await seedService(ctx.project.id, { name: "untouched" });
      await seedServiceDeployment(ctx.dep.id, completed, {
        status: "success",
        startedAt: started,
        finishedAt: new Date(started.getTime() + 123),
        durationMs: 123,
      });
      await seedServiceDeployment(ctx.dep.id, untouched, { status: "pending" });
      await repos.service.startServiceDeploymentTiming({
        deploymentId: ctx.dep.id,
        serviceId: running.id,
        serviceName: running.name,
        startedAt: started,
      });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(finish);
      ctx.provisioned.imageRef = "/tmp/disposable-service-build";
      ctx.runtime = {
        destroy: vi.fn(async () => {
          vi.setSystemTime(finish.getTime() + 60000);
        }),
      } as unknown as RuntimeAdapter;
      if (outcome === "early abort") {
        // Compose may reclaim built artifacts before reaching its terminal hook.
        // Its pre-cleanup freeze must remain authoritative after slow cleanup.
        await finishServiceDeploymentTimings(ctx);
        await ctx.runtime.destroy(ctx.provisioned.imageRef);
        ctx.provisioned = {};
        await reportPipelineError(ctx, "build disconnected", ctx.logger!);
      } else if (outcome === "failure") {
        await reportPipelineError(ctx, "build disconnected", ctx.logger!);
      } else await onCancelled(ctx);
      expect(ctx.runtime.destroy).toHaveBeenCalledOnce();
      const rows = await repos.service.listByDeployment(ctx.dep.id);
      expect(rows.find((row) => row.serviceId === running.id)).toMatchObject({
        status: "pending",
        startedAt: started,
        finishedAt: finish,
        durationMs: 4321,
      });
      expect(rows.find((row) => row.serviceId === completed.id)).toMatchObject({
        status: "success",
        durationMs: 123,
      });
      expect(rows.find((row) => row.serviceId === untouched.id)).toMatchObject({
        status: "pending",
        startedAt: null,
        finishedAt: null,
        durationMs: null,
      });
    },
  );

  it.each(["late failure", "late cancellation"] as const)(
    "preserves the cancellation transaction's pinned clock through %s",
    async (lateOutcome) => {
      const ctx = await attempt();
      await repos.deployment.updateStatus(ctx.dep.id, "cancelled", { buildDurationMs: 234 });
      const pinned = await repos.deployment.findBuildSessionByDeploymentId(ctx.dep.id);
      if (lateOutcome === "late failure")
        await reportPipelineError(ctx, "worker stopped", ctx.logger!);
      else await onCancelled(ctx, 99999);
      expect((await repos.deployment.findById(ctx.dep.id))?.buildDurationMs).toBe(234);
      expect(await repos.deployment.findBuildSessionByDeploymentId(ctx.dep.id)).toMatchObject({
        status: "cancelled",
        durationMs: pinned!.durationMs,
      });
    },
  );
});
