import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BuildLogger, DockerRuntime, type BuildConfig } from "@repo/adapters";
import type { Project } from "@repo/db";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

// Only persistence/host lookup is replaced. The Compose builder, image
// inventory, retention selection and Docker mutations below are real.
const h = vi.hoisted(() => ({
  project: undefined as unknown,
  runtime: undefined as unknown,
}));
vi.mock("@repo/platform/engine/lib/active-deployment", () => ({
  findActiveDeployment: async () => ({
    id: "image-gc-active",
    projectId: (h.project as Project).id,
    organizationId: (h.project as Project).organizationId,
    meta: {},
  }),
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  resolveDeploymentRuntime: async () => ({ runtime: h.runtime }),
}));
vi.mock("@repo/platform/engine/modules/deployments/retention-lock", () => ({
  withRetentionLock: async (_id: string, action: (project: unknown) => Promise<unknown>) =>
    action(h.project),
}));
vi.mock("@repo/platform/engine/modules/deployments/retained-artifacts", () => ({
  computeKeepSet: async () => new Set<string>(),
}));
vi.mock("@repo/platform/engine/modules/deployments/release-retention", () => ({
  refreshRollbackCapacity: async () => {},
}));

import { reapProjectImages } from "@repo/platform/engine/modules/deployments/image-gc";

describeDockerE2E("image retention while another project is building (#1369)", () => {
  let runtime: DockerRuntime;
  let directory: string;
  const key = randomUUID().replaceAll("-", "").slice(0, 12);
  const projectA = `image-gc-build-${key}`;
  const projectB = {
    id: `image-gc-pull-${key}`,
    organizationId: "image-gc-e2e",
    activeDeploymentId: "image-gc-active",
  } as Project;
  const images = new Set<string>();
  const containers = new Set<string>();

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage("busybox:1.37.0");
    directory = await mkdtemp(join(tmpdir(), "openship-gc-build-"));
    await writeFile(
      join(directory, "Dockerfile"),
      [
        "FROM busybox:1.37.0",
        // Gate the build inside a real RUN instead of hoping a timed sleep races
        // the other deploy. Bound it so a broken test never leaves a build running.
        "RUN echo OPENSHIP_GC_BUILD_WAIT && " +
          "for i in $(seq 1 60); do test -f /tmp/continue && break; sleep 1; done && " +
          "test -f /tmp/continue && " +
          "dd if=/dev/urandom of=/payload bs=1M count=64 2>/dev/null && " +
          "echo exported-after-cleanup > /artifact",
        'CMD ["cat", "/artifact"]',
        "",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    if (runtime) {
      for (const id of containers) {
        await runtime.docker
          .getContainer(id)
          .remove({ force: true })
          .catch((error) => {
            if (error.statusCode !== 404) throw error;
          });
      }
      for (const image of images) await runtime.removeImage(image);
      await runtime.dispose();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("lets a Compose image finish exporting after another project's pull and retention cleanup", async () => {
    const logs: string[] = [];
    let buildContainer: string | undefined;
    let rawOutput = "";
    let signalReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const logger = new BuildLogger(
      (entry) => {
        logs.push(entry.message);
        if (entry.message.trim() === "OPENSHIP_GC_BUILD_WAIT") signalReady();
      },
      (data) => {
        // The user-facing logger intentionally hides intermediate container IDs.
        rawOutput = (rawOutput + data).slice(-8192);
        const match = rawOutput.match(/Running in ([a-f0-9]{12,64})\s/);
        if (match) {
          buildContainer = match[1];
          containers.add(buildContainer!);
        }
      },
    );
    const config: BuildConfig = {
      sessionId: `bld_gc_${key}`,
      projectId: projectA,
      slug: projectA,
      localPath: directory,
      repoUrl: "",
      branch: "main",
      stack: "docker",
      buildImage: "",
      runtimeImage: "",
      packageManager: "",
      installCommand: "",
      buildCommand: "",
      outputDirectory: "",
      startCommand: "",
      port: 8080,
      envVars: {},
      // Exercise the legacy Engine builder from the report, including its
      // resource caps. A fix must not depend on replacing the user's builder.
      resources: { cpuCores: 0, memoryMb: 128, diskMb: 0 },
    };
    let completed = false;
    const building = runtime
      .buildImages(
        [{ config, serviceName: "app", requireRepositoryDockerfile: true, logger }],
        logger,
      )
      .finally(() => {
        completed = true;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        building.then(() => {
          throw new Error(`Build ended before overlap:\n${logs.join("")}`);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Build did not reach RUN:\n${logs.join("")}`)),
            30_000,
          );
        }),
      ]);
      expect(buildContainer).toBeTruthy();
      await runtime.pullImage("busybox:1.36.1");

      h.project = projectB;
      h.runtime = await DockerRuntime.create({ transport: "socket" });
      expect(await reapProjectImages(projectB)).toEqual({
        removed: 0,
        bytes: 0,
        skippedInUse: 0,
        errors: 0,
      });
      await (await runtime.inContainerExecutor(buildContainer!)).exec("touch /tmp/continue");
      // Keep cleanup overlapping the actual layer export, not just RUN. On
      // containerd, pruning during RUN alone can lose leases without failing
      // the later commit. The incompressible layer makes export observable.
      while (!completed) {
        await reapProjectImages(projectB);
        await delay(25);
      }
      const result = (await building)[0]!.result;
      if (result.imageRef) images.add(result.imageRef);
      expect(result.status, result.errorMessage ?? logs.join("")).toBe("deploying");

      const built = await runtime.docker.createContainer({
        Image: result.imageRef!,
        Cmd: ["sleep", "60"],
        HostConfig: { NetworkMode: "none" },
      });
      containers.add(built.id);
      await built.start();
      expect(
        (await (await runtime.inContainerExecutor(built.id)).exec("cat /artifact")).trim(),
      ).toBe("exported-after-cleanup");
    } finally {
      if (timer) clearTimeout(timer);
      if (buildContainer) {
        await (await runtime.inContainerExecutor(buildContainer))
          .exec("touch /tmp/continue")
          .catch(() => {});
      }
      const result = (await building)[0]?.result;
      if (result?.imageRef) images.add(result.imageRef);
    }
  });
});
