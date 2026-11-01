import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  DockerRuntime,
  resolveExecutor,
  type BackupExecutor,
  type ServiceHandle,
} from "@repo/adapters";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

describeDockerE2E("volume restore validates before clearing (#1417)", () => {
  let runtime: DockerRuntime;
  let executor: BackupExecutor;
  let containerId: string;
  let service: ServiceHandle;
  let sourceId: string;
  let archive: Buffer;
  let digest: string;
  const volume = `openship-restore-integrity-${randomUUID()}`;
  const command = async (cmd: string) =>
    (await (await runtime.inContainerExecutor(containerId)).exec(cmd)).trim();

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    executor = resolveExecutor("docker", runtime);
    await runtime.pullImage("alpine:3");
    await runtime.docker.createVolume({ Name: volume });
    const container = await runtime.docker.createContainer({
      Image: "alpine:3",
      Cmd: ["sleep", "3600"],
      NetworkDisabled: true,
      HostConfig: { Binds: [`${volume}:/data`] },
    });
    containerId = container.id;
    await container.start();
    service = {
      id: "restore-test",
      projectId: "restore-test",
      name: "data",
      image: "alpine:3",
      projectSlug: "restore-test",
      containerId: null,
      namespaceVolumes: false,
      env: {},
      volumes: [`${volume}:/data`],
    };
    sourceId = (await executor.listSources(service))[0]!.id;
    await command("dd if=/dev/urandom of=/data/blob bs=1048576 count=32 2>/dev/null");
    digest = await command("sha256sum /data/blob");
    const capture = await executor.streamPath(service, sourceId, { compression: "none" });
    const chunks: Buffer[] = [];
    for await (const chunk of capture.stdout) chunks.push(Buffer.from(chunk));
    expect((await capture.awaitExit).code).toBe(0);
    archive = Buffer.concat(chunks);
    expect(archive.length).toBeGreaterThan(32 * 1024 * 1024);
  });

  afterAll(async () => {
    if (containerId) await runtime.docker.getContainer(containerId).remove({ force: true });
    if (runtime) {
      await runtime.docker.getVolume(volume).remove();
      await runtime.dispose();
    }
  });

  async function seed() {
    await command("rm -f /data/blob; printf PRECIOUS > /data/keep");
  }

  function chunks(bytes: Buffer, fail = false) {
    return Readable.from(
      (async function* () {
        for (let offset = 0; offset < bytes.length; offset += 32768) {
          yield bytes.subarray(offset, offset + 32768);
          if (fail && offset >= 32768) throw new Error("source disconnected");
        }
      })(),
    );
  }

  it.each(["none", "gzip"] as const)(
    "restores every byte of a large %s archive",
    async (compression) => {
      const { gzipSync } = await import("node:zlib");
      const bytes = compression === "gzip" ? gzipSync(archive) : archive;
      await seed();
      const result = await executor.receiveStream(service, sourceId, chunks(bytes), {
        compression,
        clearTarget: true,
        timeoutMs: 30_000,
      });
      expect(result.bytesWritten).toBe(bytes.length);
      expect(await command("sha256sum /data/blob")).toBe(digest);
      expect(await command("test ! -e /data/keep && echo cleared")).toBe("cleared");
    },
  );

  it.each(["truncated tar", "truncated gzip", "empty", "source failure"])(
    "preserves the existing volume after %s",
    async (failure) => {
      const { gzipSync } = await import("node:zlib");
      const compression = failure === "truncated gzip" ? "gzip" : "none";
      const bytes =
        failure === "empty"
          ? Buffer.alloc(0)
          : failure === "truncated gzip"
            ? gzipSync(archive).subarray(0, 96 * 1024)
            : failure === "truncated tar"
              ? archive.subarray(0, 96 * 1024)
              : archive;
      await seed();
      await expect(
        executor.receiveStream(service, sourceId, chunks(bytes, failure === "source failure"), {
          compression,
          clearTarget: true,
          timeoutMs: 30_000,
        }),
      ).rejects.toThrow();
      expect(await command("cat /data/keep")).toBe("PRECIOUS");
      expect(await command("test ! -e /data/blob && echo intact")).toBe("intact");
    },
  );

  it("restores when the daemon's default logging driver cannot read receipts", async () => {
    const createContainer = runtime.docker.createContainer.bind(runtime.docker);
    // Emulate a daemon default of log-driver=none without reconfiguring it.
    const create = vi.spyOn(runtime.docker, "createContainer").mockImplementation((options) =>
      createContainer({
        ...options,
        HostConfig: { LogConfig: { Type: "none", Config: {} }, ...options.HostConfig },
      }),
    );
    try {
      await seed();
      await executor.receiveStream(service, sourceId, chunks(archive), {
        compression: "none",
        clearTarget: true,
        timeoutMs: 30_000,
      });
      expect(await command("sha256sum /data/blob")).toBe(digest);
      expect(await command("test ! -e /data/keep && echo cleared")).toBe("cleared");
    } finally {
      create.mockRestore();
    }
  });
});
