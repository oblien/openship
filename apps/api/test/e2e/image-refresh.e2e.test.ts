import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { DockerRuntime, type BuildConfig } from "@repo/adapters";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDockerE2E, dockerSocketPath, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const runId = randomUUID();
const marker = "org.openship.e2e.stale-base";
const base = "alpine:3.20";
const stale = `openship/image-refresh-fixture:${runId}`;
const environment = { ...process.env, DOCKER_HOST: `unix://${dockerSocketPath}` };
const docker = (...args: string[]) =>
  exec("docker", args, { env: environment, maxBuffer: 1024 * 1024 });

describeDockerE2E("refreshing cached Docker base images", () => {
  let runtime: DockerRuntime;
  let root: string;
  let original: string;
  const outputs = new Set<string>();

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    root = await mkdtemp(join(tmpdir(), "openship-image-refresh-"));
    await docker("pull", base);
    original = (await runtime.docker.getImage(base).inspect()).Id;
  });

  afterAll(async () => {
    // The fixture changes only this isolated test daemon's tag. Restore it
    // before removing our own images, including after a failed assertion.
    if (original) await runtime.docker.getImage(original).tag({ repo: "alpine", tag: "3.20" });
    for (const image of [...outputs, stale])
      await runtime?.docker
        .getImage(image)
        .remove({ force: true })
        .catch(() => {});
    await runtime?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("explicit refresh replaces a stale tagged base without clearing build cache or changing the tag", async () => {
    await writeFile(join(root, "Dockerfile"), `FROM scratch\nLABEL ${marker}="old"\n`);
    const stream = await runtime.docker.buildImage(
      { context: root, src: ["Dockerfile"] },
      { t: stale },
    );
    await new Promise<void>((resolve, reject) =>
      runtime.docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve())),
    );
    await runtime.docker.getImage(stale).tag({ repo: "alpine", tag: "3.20" });
    await writeFile(
      join(root, "Dockerfile"),
      "FROM alpine:3.20\nLABEL org.openship.e2e.application=refresh\n",
    );
    const build = async (refreshBaseImages: boolean) => {
      const config: BuildConfig = {
        sessionId: `refresh-${randomUUID()}`,
        projectId: `refresh-${runId}`,
        slug: "image-refresh-e2e",
        repoUrl: "",
        branch: "main",
        localPath: root,
        stack: "docker",
        buildImage: "",
        runtimeImage: "",
        packageManager: "",
        installCommand: "",
        buildCommand: "",
        outputDirectory: "",
        port: 3000,
        dockerfilePath: "Dockerfile",
        envVars: {},
        resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
        refreshBaseImages,
      };
      const result = await runtime.build(config);
      if (result.imageRef) outputs.add(result.imageRef);
      expect(result.status, result.errorMessage).toBe("deploying");
      return runtime.docker.getImage(result.imageRef!).inspect();
    };
    const cached = await build(false);
    expect(cached.Config.Labels?.[marker]).toBe("old");
    expect((await runtime.docker.getImage(base).inspect()).Config.Labels?.[marker]).toBe("old");
    const refreshed = await build(true);
    expect(refreshed.Config.Labels?.[marker]).toBeUndefined();
    expect(refreshed.Id).not.toBe(cached.Id);
  });
});
