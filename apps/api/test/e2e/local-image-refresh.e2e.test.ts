import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRuntime } from "@repo/adapters";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

describeDockerE2E("refreshing releases with a host-only image", () => {
  const local = `openship/local-refresh-e2e:migration-${randomUUID()}`;
  let runtime: DockerRuntime;
  let root: string;
  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    root = await mkdtemp(join(tmpdir(), "openship-local-refresh-"));
    await writeFile(
      join(root, "Dockerfile"),
      "FROM scratch\nLABEL org.openship.e2e=local-refresh\n",
    );
    const stream = await runtime.docker.buildImage(
      { context: root, src: ["Dockerfile"] },
      { t: local },
    );
    await new Promise<void>((resolve, reject) =>
      runtime.docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve())),
    );
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await runtime?.docker
      .getImage(local)
      .remove({ force: true })
      .catch(() => {});
    await runtime?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("reuses a host-only image by immutable ID during forced refresh", async () => {
    const before = await runtime.docker.getImage(local).inspect();
    const pull = vi.spyOn(runtime, "pullImage");
    try {
      const kept = await runtime.prepareDeploymentImage(before.Id, { force: true });
      expect(kept.imageId).toBe(before.Id);
      expect(kept.deploymentRef).toBe(before.Id);
      expect(pull).not.toHaveBeenCalled();
    } finally {
      pull.mockRestore();
    }
  });

  it("refreshes a registry image while preserving an explicitly retained artifact on either Docker store", async () => {
    const before = await runtime.docker.getImage(local).inspect();
    const remote = "busybox:1.37";
    await runtime.pullImage(remote);
    const pull = vi.spyOn(runtime, "pullImage"); // observes real pulls; no mock transport
    const [preserved, refreshed] = await Promise.all([
      runtime.prepareDeploymentImage(local, { force: true, requirePresent: true }),
      runtime.prepareDeploymentImage(remote, { force: true }),
    ]);
    expect(preserved.imageId).toBe(before.Id);
    expect((await runtime.docker.getImage(local).inspect()).Id).toBe(before.Id);
    expect(refreshed.registryDigest).toMatch(/busybox(?::1\.37)?@sha256:/);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(pull.mock.calls[0]?.[0]).toBe(remote);
  });
});
