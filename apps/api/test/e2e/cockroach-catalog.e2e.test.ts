import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import {
  DockerRuntime,
  type MultiServiceDeployConfig,
  type MultiServiceGroupHandle,
} from "@repo/adapters";
import { LOCAL_SERVICE_CATALOG } from "../../../dashboard/src/app/(dashboard)/projects/[id]/components/services/local-service-catalog";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

describeDockerE2E("CockroachDB companion service (#1484)", () => {
  const entry = LOCAL_SERVICE_CATALOG.find((item) => item.id === "cockroachdb")!;
  const projectId = `cockroach-e2e-${randomUUID().slice(0, 12)}`;
  const marker = randomUUID();
  const environment = Object.fromEntries(
    entry.defaultEnv!.map((item) => [
      item.key,
      item.generate === "secret" ? randomBytes(24).toString("hex") : item.value!,
    ]),
  );
  const volumes = new Set<string>();
  let runtime: DockerRuntime;
  let group: MultiServiceGroupHandle;

  function config(deploymentId: string): MultiServiceDeployConfig {
    return {
      deploymentId,
      projectId,
      slug: projectId,
      serviceName: "database",
      image: entry.image!,
      commandArgv: entry.commandArgv,
      environment,
      volumes: entry.defaultVolumes!,
      namespaceVolumes: true,
      // The disposable client connects over the project network; publish nothing.
      ports: [],
      restart: "no",
      resources: { cpuCores: 1, memoryMb: 2048 },
      imageAlreadyPrepared: true,
    };
  }

  async function remember(id: string) {
    for (const name of await runtime.inspectNamedVolumes(id)) volumes.add(name);
    return id;
  }

  /** A separate container proves service DNS, TLS and password authentication. */
  async function sql(query: string, password = environment.COCKROACH_PASSWORD) {
    const url = new URL(
      `postgresql://database:${entry.ports![0]}/${environment.COCKROACH_DATABASE}`,
    );
    url.username = environment.COCKROACH_USER;
    url.password = password;
    // The upstream image generates a private CA. Encrypt the connection without
    // requiring the test client to have its root certificate installed.
    url.searchParams.set("sslmode", "require");
    const client = await runtime.docker.createContainer({
      Image: entry.image!,
      Cmd: ["sql", "--url", url.toString(), "--format=csv", "--execute", query],
      Labels: { "openship.project": projectId, "openship.test": "cockroach-catalog" },
      HostConfig: { NetworkMode: group.id, Memory: 256 * 1024 * 1024, NanoCpus: 1_000_000_000 },
    });
    try {
      await client.start();
      const result = await client.wait();
      const output = (await client.logs({ stdout: true, stderr: true })).toString();
      return { code: result.StatusCode, output };
    } finally {
      await client.remove({ force: true, v: true });
    }
  }

  async function ready(id: string) {
    await vi.waitFor(
      async () => {
        const state = (await runtime.docker.getContainer(id).inspect()).State;
        expect(state.Running).toBe(true);
        const result = await sql("SELECT current_user, current_database()");
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain(
          `${environment.COCKROACH_USER},${environment.COCKROACH_DATABASE}`,
        );
      },
      { timeout: 90_000, interval: 1000 },
    );
  }

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage(entry.image!);
    // Reuse an isolated project network through the normal runtime group path.
    await runtime.docker.createNetwork({
      Name: `openship-${projectId}`,
      Internal: true,
      Labels: { "openship.test": "cockroach-catalog" },
    });
    group = await runtime.ensureServiceGroup({ projectId, slug: projectId, deploymentId: "first" });
  });

  afterAll(async () => {
    if (!runtime) return;
    try {
      for (const id of await runtime.listProjectContainerIds(projectId)) {
        await remember(id);
        await runtime.docker.getContainer(id).remove({ force: true, v: true });
      }
      for (const name of volumes) await runtime.docker.getVolume(name).remove();
      await runtime.removeNetwork(projectId);
    } finally {
      await runtime.dispose();
    }
  });

  it("reproduces the missing mode, then authenticates and retains data and TLS across replacement", async () => {
    const broken = await runtime.deployServiceWorkload(group, {
      ...config("missing-command"),
      commandArgv: undefined,
    });
    const brokenId = await remember(broken.containerId!);
    await vi.waitFor(
      async () => {
        const state = (await runtime.docker.getContainer(brokenId).inspect()).State;
        expect(state.Running).toBe(false);
        expect(state.ExitCode).not.toBe(0);
      },
      { timeout: 15_000 },
    );
    expect(
      (await runtime.docker.getContainer(brokenId).logs({ stdout: true, stderr: true })).toString(),
    ).toContain("mode unset");
    await runtime.destroy(brokenId);

    const first = await runtime.deployServiceWorkload(group, config("first"));
    const firstId = await remember(first.containerId!);
    await ready(firstId);
    const denied = await sql("SELECT 1", "incorrect-password");
    expect(denied.code).not.toBe(0);
    expect(denied.output).toContain("password authentication failed");
    const write = await sql(
      `CREATE TABLE persistence_check (value STRING PRIMARY KEY); INSERT INTO persistence_check VALUES ('${marker}')`,
    );
    expect(write.code, write.output).toBe(0);
    const cert = await (
      await runtime.inContainerExecutor(firstId)
    ).exec("sha256sum /cockroach/certs/ca.crt");
    const firstVolumes = await runtime.inspectNamedVolumes(firstId);
    let previousId = firstId;
    for (const next of [
      config("replacement"),
      {
        // Existing saved services can use the image's supported environment
        // override from the normal settings form, even before an OpenShip update.
        ...config("environment-recovery"),
        commandArgv: undefined,
        environment: { ...environment, COCKROACH_ARGS: entry.commandArgv!.join(" ") },
      },
    ]) {
      await runtime.destroy(previousId);
      const replacement = await runtime.deployServiceWorkload(group, next);
      const replacementId = await remember(replacement.containerId!);
      await ready(replacementId);
      expect((await runtime.inspectNamedVolumes(replacementId)).sort()).toEqual(
        [...firstVolumes].sort(),
      );
      expect(
        await (
          await runtime.inContainerExecutor(replacementId)
        ).exec("sha256sum /cockroach/certs/ca.crt"),
      ).toBe(cert);
      const read = await sql("SELECT value FROM persistence_check");
      expect(read.code, read.output).toBe(0);
      expect(read.output).toContain(marker);
      const state = (await runtime.docker.getContainer(replacementId).inspect()).State;
      expect(state.Running).toBe(true);
      expect(state.OOMKilled).toBe(false);
      previousId = replacementId;
    }
  });
});
