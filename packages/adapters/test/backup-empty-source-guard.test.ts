/** Verified empty sources are valid; missing sources must never be created by capture. */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { DockerRuntime } from "../src/runtime/docker";
import { DockerBackupExecutor } from "../src/backup/executors/docker";
import { VolumeCopyProducer } from "../src/backup/producers/volume";
import type { ServiceHandle } from "../src/backup/types";

const SERVICE: ServiceHandle = {
  id: "svc_1",
  projectId: "prj_1",
  name: "optional-storage",
  image: "alpine:3",
  env: {},
  volumes: [],
  containerId: null,
  projectSlug: "backup-empty-regression",
  namespaceVolumes: false,
};

const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const dockerRequired = process.env.RUN_DOCKER_E2E === "1";

describe.skipIf(!dockerAvailable && !dockerRequired)("Docker capture source existence", () => {
  let runtime: DockerRuntime;
  let executor: DockerBackupExecutor;
  let root: string;
  let containerId: string;
  const prefix = `openship-empty-${randomUUID()}`;
  const volumes = ["empty", "populated", "unavailable"].map((name) => `${prefix}-${name}`);

  beforeAll(async () => {
    if (!dockerAvailable) throw new Error("RUN_DOCKER_E2E=1 requires Docker");
    runtime = await DockerRuntime.create({ transport: "socket" });
    executor = new DockerBackupExecutor(runtime);
    await runtime.pullImage("alpine:3");
    root = await mkdtemp(join(tmpdir(), "openship-empty-source-"));
    for (const name of volumes.slice(0, 2)) await runtime.docker.createVolume({ Name: name });
    await runtime.docker.createVolume({
      Name: volumes[2],
      Driver: "local",
      DriverOpts: { type: "none", o: "bind", device: join(root, "missing-storage") },
    });
    const helper = await runtime.docker.createContainer({
      Image: "alpine:3",
      Cmd: ["sh", "-c", "echo important-data > /data/keep.txt"],
      HostConfig: { Binds: [`${volumes[1]}:/data`] },
    });
    try {
      await helper.start();
      expect((await helper.wait()).StatusCode).toBe(0);
    } finally {
      await helper.remove({ force: true });
    }
    const service = await runtime.docker.createContainer({
      Image: "alpine:3",
      Cmd: ["sleep", "300"],
      HostConfig: {
        Binds: [`${volumes[0]}:/optional`, `${root}:/empty-bind`, `${volumes[1]}:/data`],
      },
    });
    containerId = service.id;
    await service.start();
  }, 120_000);

  afterAll(async () => {
    if (containerId) await runtime.docker.getContainer(containerId).remove({ force: true });
    if (runtime)
      for (const name of volumes)
        await runtime.docker
          .getVolume(name)
          .remove()
          .catch(() => {});
    if (root) await rm(root, { recursive: true, force: true });
  });

  const collect = async (stdout: NodeJS.ReadableStream) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stdout) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };

  it("captures empty named and bind sources alongside a populated sibling", async () => {
    const service = { ...SERVICE, containerId };
    const archives = new Map<string, Buffer>();
    for await (const artifact of VolumeCopyProducer.produce(service, executor, {
      compression: "gzip",
    })) {
      const bytes = await collect(artifact.stream);
      archives.set(String(artifact.metadata.volumeSource), bytes);
    }
    expect(archives.size).toBe(3);
    for (const source of [volumes[0], root]) {
      const bytes = archives.get(source)!;
      const listing = spawnSync("tar", ["-tzf", "-"], { input: bytes });
      expect(listing.status, listing.stderr.toString()).toBe(0);
      expect(listing.stdout.toString().trim()).toBe("./");
    }
    const restored = spawnSync("tar", ["-xzOf", "-", "./keep.txt"], {
      input: archives.get(volumes[1]),
    });
    expect(restored.status, restored.stderr.toString()).toBe(0);
    expect(restored.stdout.toString()).toBe("important-data\n");
  });

  it("rejects a volume absent from this daemon without creating it", async () => {
    const name = `${prefix}-wrong-host`;
    const service = { ...SERVICE, volumes: [`${name}:/data`] };
    await expect(
      executor.streamPath(service, `${name}-0`, { compression: "gzip" }),
    ).rejects.toThrow();
    await expect(runtime.docker.getVolume(name).inspect()).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("rejects a missing bind path without creating a directory", async () => {
    const missing = join(root, "missing-bind");
    const service = { ...SERVICE, volumes: [`${missing}:/data`] };
    await expect(
      executor.streamPath(service, `${missing}-0`, { compression: "gzip" }),
    ).rejects.toThrow();
    await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an existing volume whose backing storage is unavailable", async () => {
    const name = volumes[2];
    const service = { ...SERVICE, volumes: [`${name}:/data`] };
    await expect(
      executor.streamPath(service, `${name}-0`, { compression: "gzip" }),
    ).rejects.toThrow();
  });
});
