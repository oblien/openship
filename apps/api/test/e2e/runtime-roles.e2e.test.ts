import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, repos, schema } from "@repo/db";
import { seedDeployment, seedOrg, seedProject, setActive } from "../helpers/seed";
import { BuildLogger, DockerRuntime, type DeployConfig } from "@repo/adapters";
import { SYSTEM, type StackRole } from "@repo/core";
import {
  rolloutRoles,
  type RoleRollout,
  type RoleRolloutDeps,
} from "@repo/platform/engine/modules/deployments/role-rollout";
import { runtimeRoleRolloutDeps } from "@repo/platform/engine/modules/deployments/role-runtime";
import { describeDockerE2E, requireDocker, dockerSocketPath } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const projectId = `roles-e2e-${process.pid}`;
const slug = projectId;
const sourceName = `${slug}-database`;
const externalNetwork = `openship-${sourceName}`;
const volume = `openship-${slug}-data`;
const baseImage = "busybox:1.37";
const image = `openship-roles-e2e:${process.pid}`;
let runtime: DockerRuntime;

vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/deployment-runtime")>()),
  withDeploymentRuntime: async (_dep: unknown, run: (runtime: DockerRuntime) => Promise<unknown>) =>
    run(runtime),
}));
// No domains exist in this fixture; the test exercises Docker and durable role
// recovery without provisioning a host edge or issuing certificates.
vi.mock("@repo/platform/engine/modules/projects/project-runtime.service", () => ({
  retryProjectRouting: async () => ({ ok: true }),
}));

async function docker(...args: string[]): Promise<string> {
  return (
    await exec("docker", ["--host", `unix://${dockerSocketPath}`, ...args], { timeout: 120_000 })
  ).stdout.trim();
}

function config(deploymentId: string): DeployConfig {
  return {
    projectId,
    slug,
    runtimeName: slug,
    networkAlias: "app",
    deploymentId,
    buildSessionId: "roles-e2e",
    imageRef: image,
    environment: "production",
    port: 8080,
    startCommand: "exec httpd -f -p 8080 -h /tmp",
    // PORT is set by both the project and the image (ENV below); a role must see neither.
    envVars: { E2E_DEPLOYMENT: deploymentId, PORT: "9999" },
    resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
    volumes: ["data:/data"],
    restartPolicy: "always",
  };
}

// The worker proves the external network was joined BEFORE its process started: a
// network attached after start would make this first lookup fail and the worker exit.
const worker = (extra: Partial<StackRole> = {}): StackRole => ({
  name: "queue",
  kind: "worker",
  replicas: 2,
  command:
    "wget -qO- http://database:8080 > /dev/null || exit 1; trap 'exit 0' TERM; while :; do sleep 1 & wait $!; done",
  ...extra,
});
const scheduler = (command?: string): StackRole => ({
  name: "scheduler",
  kind: "scheduler",
  command:
    command ??
    "trap 'echo \"stop-$E2E_DEPLOYMENT\" >> /data/sched.log; exit 0' TERM; " +
      'echo "start-$E2E_DEPLOYMENT" >> /data/sched.log; while :; do sleep 1 & wait $!; done',
});

function rollout(
  deploymentId: string,
  roles: StackRole[],
  previous?: RoleRollout,
  overrides: Partial<
    Pick<RoleRolloutDeps, "destroyStarted" | "teardownTimeoutMs" | "log" | "previousRoles">
  > = {},
) {
  return rolloutRoles({
    ...runtimeRoleRolloutDeps({
      roles,
      previous: previous?.started,
      runtime,
      previousRuntime: runtime,
      config: config(deploymentId),
      logger: new BuildLogger(() => {}),
      beforeStart: (containerId) =>
        runtime.attachToExternalNetworks(projectId, [externalNetwork], [], {
          onlyContainerIds: [containerId],
          strict: true,
        }),
      stabilizationWindowMs: 5000,
      keepProvisionedOnCancel: () => false,
    }),
    ...overrides,
  });
}

/** `id state` for every container of one deployment, running or not. */
async function containersOf(deploymentId: string): Promise<{ id: string; state: string }[]> {
  const out = await docker(
    "ps",
    "-a",
    "--filter",
    `label=openship.deployment=${deploymentId}`,
    "--format",
    "{{.ID}} {{.State}}",
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, state] = line.split(" ");
      return { id, state };
    });
}
async function stateOf(containerId: string): Promise<string> {
  return docker("inspect", "--format", "{{.State.Status}}", containerId);
}
async function expectAllRunning(rolloutHandle: RoleRollout) {
  for (const ref of rolloutHandle.started) expect(await stateOf(ref.containerId)).toBe("running");
}
/** The scheduler log, read through a throwaway container that mounts the same volume. */
async function schedulerLog(): Promise<string> {
  const out = await docker(
    "run",
    "--rm",
    "-v",
    `${volume}:/data`,
    baseImage,
    "cat",
    "/data/sched.log",
  );
  return out.split("\n").filter(Boolean).join(",");
}

describeDockerE2E("runtime roles against Docker", () => {
  let a: RoleRollout;
  let b: RoleRollout;
  const dep = (name: string) => `${slug}-${name}`;

  beforeAll(async () => {
    await requireDocker();
    await docker("pull", baseImage);
    const source = await mkdtemp(join(tmpdir(), "openship-roles-image-"));
    try {
      await writeFile(
        join(source, "Dockerfile"),
        [
          `FROM ${baseImage}`,
          "ENV PORT=3000",
          "HEALTHCHECK --interval=1s --timeout=1s --retries=1 CMD wget -qO- http://127.0.0.1:8080/ > /dev/null || exit 1",
          "",
        ].join("\n"),
      );
      await docker("build", "-t", image, source);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
    runtime = await DockerRuntime.create({ transport: "socket", dockerSocketPath });
    await docker("network", "create", externalNetwork);
    await docker(
      "run",
      "-d",
      "--name",
      sourceName,
      "--network",
      externalNetwork,
      "--network-alias",
      "database",
      baseImage,
      "sh",
      "-c",
      "mkdir -p /www; printf database-ready > /www/index.html; exec httpd -f -p 8080 -h /www",
    );
  });
  afterAll(async () => {
    try {
      const ids = (await docker("ps", "-aq", "--filter", `label=openship.project=${projectId}`))
        .split("\n")
        .filter(Boolean);
      if (ids.length) await docker("rm", "-fv", ...ids);
      await docker("rm", "-f", sourceName).catch(() => {});
      await docker("volume", "rm", volume).catch(() => {});
      await docker("network", "rm", externalNetwork, `openship-${slug}`).catch(() => {});
      await docker("image", "rm", image).catch(() => {});
    } finally {
      await runtime?.dispose();
    }
  });

  it("keeps the image's HTTP healthcheck working for the web process", async () => {
    const name = `${slug}-web-health`;
    try {
      await docker(
        "run",
        "-d",
        "--name",
        name,
        "--label",
        `openship.project=${projectId}`,
        image,
        "sh",
        "-c",
        "mkdir -p /www; printf web-ready > /www/index.html; exec httpd -f -p 8080 -h /www",
      );
      await expect
        .poll(() => docker("inspect", "--format", "{{.State.Health.Status}}", name), {
          timeout: 15_000,
        })
        .toBe("healthy");
    } finally {
      await docker("rm", "-f", name);
    }
  });

  it("starts the first release's roles portless, labeled and without PORT", async () => {
    a = await rollout(dep("a"), [worker(), scheduler()]);
    await a.commit();

    const running = await containersOf(dep("a"));
    expect(running).toHaveLength(3);
    expect(running.every((c) => c.state === "running")).toBe(true);
    for (const { id } of running) {
      const labels = JSON.parse(await docker("inspect", "--format", "{{json .Config.Labels}}", id));
      expect(["queue", "scheduler"]).toContain(labels["openship.role"]);
      expect(await docker("port", id)).toBe("");
      const env: string[] = JSON.parse(
        await docker("inspect", "--format", "{{json .Config.Env}}", id),
      );
      expect(env.some((entry) => entry.startsWith("PORT="))).toBe(false);
      expect(env).toContain(`E2E_DEPLOYMENT=${dep("a")}`);
      // What the role process itself sees, after Docker merged the image's ENV.
      const processEnv = (await docker("exec", id, "cat", "/proc/1/environ")).split("\0");
      expect(processEnv).toContain(`E2E_DEPLOYMENT=${dep("a")}`);
      expect(processEnv.some((entry) => entry.startsWith("PORT="))).toBe(false);
      expect(
        JSON.parse(await docker("inspect", "--format", "{{json .Config.Healthcheck.Test}}", id)),
      ).toEqual(["NONE"]);
    }
    expect(await schedulerLog()).toBe(`start-${dep("a")}`);
  });

  it("starts workers beside the old ones, hands the scheduler over stop-first, and retires the old release on commit", async () => {
    b = await rollout(dep("b"), [worker(), scheduler()], a);

    // Before commit: the old workers still serve jobs, the old scheduler is stopped but kept.
    const before = await containersOf(dep("a"));
    expect(before).toHaveLength(3);
    const byRole = async (state: string) =>
      (
        await Promise.all(
          a.started.map(async (ref) => ({ role: ref.role, state: await stateOf(ref.containerId) })),
        )
      )
        .filter((c) => c.state === state)
        .map((c) => c.role);
    expect((await byRole("running")).sort()).toEqual(["queue", "queue"]);
    expect(await byRole("exited")).toEqual(["scheduler"]);
    await expectAllRunning(b);

    await b.commit();
    expect(await containersOf(dep("a"))).toEqual([]);
    await expectAllRunning(b);
    expect(await schedulerLog()).toBe(`start-${dep("a")},stop-${dep("a")},start-${dep("b")}`);
  });

  it("fails a deploy whose worker crashes and leaves the running release untouched", async () => {
    const logBefore = await schedulerLog();
    await expect(
      rollout(dep("c"), [worker({ command: "exit 1" }), scheduler()], b),
    ).rejects.toThrow(/Role startup check failed/);

    await expectAllRunning(b);
    expect(await schedulerLog()).toBe(logBefore);
    expect(await containersOf(dep("c"))).toEqual([]);
  });

  it("restarts the old scheduler when the new one crashes", async () => {
    await expect(rollout(dep("d"), [worker(), scheduler("exit 3")], b)).rejects.toThrow(
      /Role startup check failed/,
    );

    await expectAllRunning(b);
    expect(await containersOf(dep("d"))).toEqual([]);
    const log = (await schedulerLog()).split(",");
    expect(log.at(-1)).toBe(`start-${dep("b")}`);
    expect(log).toContain(`stop-${dep("b")}`);
  });

  it.each(["reject", "timeout"] as const)(
    "does not restart the previous scheduler when replacement removal ends in %s",
    async (failure) => {
      const warnings: string[] = [];
      let releaseCleanup!: () => void;
      const cleanupGate = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      let pendingCleanup: Promise<void> | undefined;
      const next = await rollout(dep(`uncertain-${failure}`), [scheduler()], b, {
        teardownTimeoutMs: 2_000,
        destroyStarted(id) {
          if (failure === "reject") return Promise.reject(new Error("Docker removal failed"));
          pendingCleanup = cleanupGate.then(() => runtime.destroy(id));
          return pendingCleanup;
        },
        log(message, level) {
          if (level === "warn") warnings.push(message);
        },
      });
      const replacementId = next.started[0]!.containerId;
      const previousId = b.started.find((ref) => ref.role === "scheduler")!.containerId;
      try {
        await next.abort();
        expect(await stateOf(previousId)).toBe("exited");
        expect(await stateOf(replacementId)).toBe("running");
        const schedulers = await docker(
          "ps",
          "-q",
          "--filter",
          `label=openship.project=${projectId}`,
          "--filter",
          "label=openship.role=scheduler",
        );
        expect(schedulers.split("\n").filter(Boolean)).toHaveLength(1);
        const warning = warnings.find((line) => line.includes("Rollback incomplete"));
        expect(warning).toContain(previousId);
        expect(warning).toContain(replacementId);
      } finally {
        // A late removal may finish after the timeout. Confirm removal before
        // restoring the previous scheduler for the next test.
        releaseCleanup();
        if (pendingCleanup) await pendingCleanup;
        else await runtime.destroy(replacementId);
        expect(await stateOf(previousId)).toBe("exited");
        await runtime.start(previousId);
      }
      await expectAllRunning(b);
    },
  );

  it("retires every role container when the release declares none", async () => {
    const e = await rollout(dep("e"), [], b);
    expect(e.started).toEqual([]);
    await e.commit();

    expect(await containersOf(dep("b"))).toEqual([]);
    expect(await containersOf(dep("e"))).toEqual([]);
  });

  it("stops a renamed scheduler before its replacement starts (#1253)", async () => {
    const f = await rollout(dep("f"), [scheduler()]);
    await f.commit();
    const cron = { ...scheduler(), name: "cron" };
    const g = await rollout(dep("g"), [cron], f, { previousRoles: [scheduler()] });

    // Before commit the renamed predecessor is stopped and kept, not running beside cron.
    expect(await stateOf(f.started[0]!.containerId)).toBe("exited");
    await expectAllRunning(g);
    await g.commit();
    expect(await containersOf(dep("f"))).toEqual([]);
    expect((await schedulerLog()).split(",").slice(-3)).toEqual([
      `start-${dep("f")}`,
      `stop-${dep("f")}`,
      `start-${dep("g")}`,
    ]);
  });

  it("scales runtime roles with the active image while preserving web and unchanged replicas (#1283)", async () => {
    const { runRoleConfigurationRollout } = await import("@repo/platform/engine/modules/deployments/role-configuration-rollout");
    const org = await seedOrg();
    const ownedProjectId = `role-configuration-${process.pid}`;
    const project = await seedProject(org.organizationId, { id: ownedProjectId, readiness: { stabilizationSeconds: 1 } });
    const queue = worker({ replicas: 1, command: "trap 'exit 0' TERM; while :; do sleep 1 & wait $!; done" });
    const cron = scheduler("trap 'exit 0' TERM; while :; do sleep 1 & wait $!; done");
    const original = await seedDeployment(project, { meta: { runtimeMode: "docker", roles: [queue, cron] } });
    const cfg = (id: string): DeployConfig => ({ ...config(id), projectId: project.id, slug: ownedProjectId,
      runtimeName: ownedProjectId, networkAlias: undefined, envVars: { E2E_DEPLOYMENT: original.id }, volumes: [] });
    try {
      const web = await runtime.deploy(cfg(original.id));
      await repos.deployment.setContainerId(original.id, web.containerId);
      const first = await rolloutRoles(runtimeRoleRolloutDeps({ roles: [queue, cron], previous: [], runtime, previousRuntime: runtime,
        config: cfg(original.id), logger: new BuildLogger(() => {}), beforeStart: async () => {}, stabilizationWindowMs: 1000,
        keepProvisionedOnCancel: () => false }));
      await repos.deployment.setRoleContainers(original.id, [...first.started]);
      await setActive(project.id, original.id);
      const imageId = (await runtime.inspectContainer(web.containerId))!.imageId;
      const webStarted = await docker("inspect", "--format", "{{.State.StartedAt}}", web.containerId);
      const apply = async (roles: StackRole[]) => {
        const live = (await repos.project.findById(project.id))!;
        const active = (await repos.deployment.findById(live.activeDeploymentId!))!;
        const meta = { runtimeMode: "docker", roles, webOwnerDeploymentId: original.id,
          roleConfiguration: { sourceDeploymentId: active.id, webContainerId: web.containerId, webOwnerDeploymentId: original.id, imageId } };
        const next = await seedDeployment(live, { status: "deploying", meta });
        const messages: string[] = [];
        try { await runRoleConfigurationRollout({ project: live, dep: next, runtime, config: { ...cfg(next.id), imageRef: imageId },
          logger: new BuildLogger(entry => messages.push(entry.message)), beforeStart: async () => {}, publish: async containerId => {
            await repos.deployment.setContainerId(next.id, containerId);
            await repos.deployment.updateStatus(next.id, "ready");
            await setActive(project.id, next.id);
          } });
        } catch (error) {
          // The normal worker's lifecycle hook records this outcome; this fixture calls the rollout directly.
          await repos.deployment.updateStatus(next.id, "failed");
          throw error;
        }
        const watch = `(${live.readiness!.stabilizationSeconds}s stabilization window)`;
        expect(messages.some(message => message.includes(watch))).toBe(true);
        return (await repos.deployment.findById(next.id))!;
      };
      const up = await apply([{ ...queue, replicas: 3 }, cron]);
      expect(up.roleContainers).toHaveLength(4);
      for (const ref of first.started) expect(up.roleContainers!.some(next => next.containerId === ref.containerId)).toBe(true);
      const down = await apply([queue, cron]);
      expect(down.roleContainers!.map(ref => ref.containerId).sort()).toEqual(first.started.map(ref => ref.containerId).sort());
      // Healthy rollouts use a short watch to keep this fixture fast. An
      // intentional crash loop needs the normal window: a one-second sample
      // can land between restarts before Docker's backoff proves the loop.
      await repos.project.update(project.id, {
        readiness: { stabilizationSeconds: SYSTEM.DEPLOYMENTS.STABILIZE_WINDOW_MS / 1000 },
      });
      try {
        await expect(apply([{ ...queue, command: "exit 9" }, cron])).rejects.toThrow(/Role startup check failed/);
      } finally {
        await repos.project.update(project.id, { readiness: project.readiness });
      }
      expect((await repos.project.findById(project.id))!.activeDeploymentId).toBe(down.id);
      await expectAllRunning(first);
      // Returning to the earlier frozen count also requires no build or web restart.
      const restored = await apply((up.meta as { roles: StackRole[] }).roles);
      expect(restored.roleContainers).toHaveLength(4);
      expect(restored.containerId).toBe(web.containerId);
      expect(await stateOf(web.containerId)).toBe("running");
      expect(await docker("inspect", "--format", "{{.State.StartedAt}}", web.containerId)).toBe(webStarted);
      const running = await docker("ps", "--filter", `label=openship.project=${project.id}`, "--filter", "label=openship.role=scheduler", "--format", "{{.ID}}");
      expect(running.split("\n").filter(Boolean)).toHaveLength(1);
    } finally {
      for (const container of (await runtime.listAllContainers()).filter(row => row.labels?.["openship.project"] === project.id)) await runtime.destroy(container.id);
      await docker("network", "rm", `openship-${ownedProjectId}`).catch(() => {});
      await db.delete(schema.project).where(eq(schema.project.id, project.id));
    }
  });

  it("recovers an abandoned handover and keeps one scheduler on the next rollout (#1254)", async () => {
    const { beginRoleHandover, recoverProjectRoleHandovers } =
      await import("@repo/platform/engine/modules/deployments/role-handover");
    const org = await seedOrg();
    const ownedProjectId = `role-recovery-${process.pid}`;
    const project = await seedProject(org.organizationId, { id: ownedProjectId });
    const role = scheduler("trap 'exit 0' TERM; while :; do sleep 1 & wait $!; done");
    const frozen = { runtimeMode: "docker", roles: [role] };
    const h = await seedDeployment(project, { meta: frozen });
    const i = await seedDeployment(project, { status: "deploying", meta: frozen });
    const cfg = (id: string): DeployConfig => ({
      ...config(id),
      projectId: project.id,
      slug: ownedProjectId,
      runtimeName: ownedProjectId,
      networkAlias: undefined,
      volumes: [],
    });
    const deps = (id: string, previous?: RoleRollout) =>
      runtimeRoleRolloutDeps({
        roles: [role],
        previousRoles: [role],
        previous: previous?.started,
        runtime,
        previousRuntime: runtime,
        config: cfg(id),
        logger: new BuildLogger(() => {}),
        beforeStart: async () => {},
        stabilizationWindowMs: 1000,
        keepProvisionedOnCancel: () => false,
      });
    try {
      const live = await rolloutRoles(deps(h.id));
      await repos.deployment.setRoleContainers(h.id, [...live.started]);
      h.roleContainers = [...live.started];
      await setActive(project.id, h.id);
      const journal = await beginRoleHandover({
        dep: i,
        previous: h,
        roles: [role],
        config: cfg(i.id),
      });
      const abandoned = await rolloutRoles({
        ...deps(i.id, live),
        recordCreated: journal.recordCreated,
        recordStopIntent: journal.recordStopIntent,
      });
      // Lose the controller's in-memory handle without commit/abort, exactly
      // where the old restart sweep lost ownership of the running replacement.
      expect(await stateOf(live.started[0]!.containerId)).toBe("exited");
      expect(await stateOf(abandoned.started[0]!.containerId)).toBe("running");
      await repos.deployment.sweepStaleInFlight("controller restarted");
      await recoverProjectRoleHandovers(project.id);
      expect(await stateOf(live.started[0]!.containerId)).toBe("running");
      expect(await containersOf(i.id)).toEqual([]);

      const j = await seedDeployment(project, { meta: frozen });
      const next = await rolloutRoles(deps(j.id, live));
      await next.commit();
      const running = await docker(
        "ps",
        "-q",
        "--filter",
        `label=openship.project=${project.id}`,
        "--filter",
        "label=openship.role=scheduler",
      );
      expect(running.split("\n").filter(Boolean)).toHaveLength(1);
      expect(await stateOf(next.started[0]!.containerId)).toBe("running");
      expect(await repos.deployment.listPendingRoleHandovers(project.id)).toEqual([]);
    } finally {
      const ids = await docker("ps", "-aq", "--filter", `label=openship.project=${project.id}`);
      if (ids) await docker("rm", "-f", ...ids.split("\n"));
      await db.delete(schema.project).where(eq(schema.project.id, project.id));
    }
  });
});
