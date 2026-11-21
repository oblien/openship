import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerRuntime } from "./docker";
import { DockerReplicas, REPLICA_GROUP_LABEL, REPLICA_INDEX_LABEL } from "./docker-replicas";
import { setDefaultEdgeImage } from "../system/proxy/ensure-container-edge";
import type { MultiServiceDeployConfig, MultiServiceGroupHandle } from "./types";
import { sq } from "./build-pipeline";

// Opt in to an explicit test daemon; all cleanup is scoped to this run's unique project.
const socket = process.env.OPENSHIP_DOCKER_TEST_SOCKET;
describe.skipIf(!socket)("single-server replicas on Docker", () => {
  const projectId = `replica-test-${randomUUID()}`;
  let runtime: DockerRuntime;
  let group: MultiServiceGroupHandle;
  let config: MultiServiceDeployConfig;
  let ref: string;
  const app = `const http=require('http'), id=require('crypto').randomUUID();
    if(process.env.FAIL_INSTANCE==='1' && require('os').hostname().endsWith('-2')) process.exit(2);
    const server=http.createServer((req,res)=>{console.log('request '+id);res.setHeader('Connection','close');res.end(JSON.stringify({id,version:process.env.VERSION}));}).listen(8080,'0.0.0.0');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`;
  const inventory = () =>
    runtime.docker.listContainers({
      all: true,
      filters: { label: [`openship.project=${projectId}`] },
    });
  const instances = async () =>
    (await inventory()).filter(
      (row) => row.Labels[REPLICA_INDEX_LABEL] && row.Labels[REPLICA_INDEX_LABEL] !== "0",
    );
  async function request(count = 1, hostname = "api") {
    const id = (await instances())[0]?.Id;
    if (!id) throw new Error("No test application instance");
    const exec = await runtime.docker.getContainer(id).exec({
      Cmd: [
        "node",
        "-e",
        `(async()=>{for(let i=0;i<${count};i++)console.log(await(await fetch('http://${hostname}:8080/',{signal:AbortSignal.timeout(10000)})).text());})().catch(e=>{console.error(e);process.exit(1)});`,
      ],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ Detach: false, Tty: false });
    const output: Buffer[] = [];
    for await (const chunk of stream) output.push(Buffer.from(chunk));
    const raw = Buffer.concat(output);
    let text = "";
    for (let offset = 0; offset + 8 <= raw.length;) {
      const length = raw.readUInt32BE(offset + 4);
      text += raw.subarray(offset + 8, offset + 8 + length).toString();
      offset += 8 + length;
    }
    if ((await exec.inspect()).ExitCode !== 0) throw new Error(text);
    return text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string; version?: string });
  }
  beforeAll(async () => {
    runtime = await DockerRuntime.create({ dockerSocketPath: socket });
    // Same OpenResty version as the production Edge; no custom app entrypoint.
    setDefaultEdgeImage("openresty/openresty:1.27.1.1-alpine");
    await runtime.pullImage("node:24-bookworm");
    group = await runtime.ensureServiceGroup({ projectId, deploymentId: "first", slug: projectId });
    config = {
      projectId,
      deploymentId: "first",
      slug: projectId,
      serviceName: "api",
      image: "node:24-bookworm",
      replicas: 3,
      ports: [],
      advanced: { expose: ["8080/tcp"] },
      environment: { VERSION: "one" },
      volumes: [],
      namespaceVolumes: true,
      commandArgv: ["node", "-e", app],
      imageAlreadyPrepared: true,
      resources: { cpuCores: 0.25, memoryMb: 128 },
      restart: "unless-stopped",
    };
    await runtime.prepareServiceWorkload(config);
    ref = (await runtime.deployServiceWorkload(group, config)).containerId;
  }, 120_000);
  afterAll(async () => {
    if (runtime) {
      for (const row of await inventory())
        await runtime.docker.getContainer(row.Id).remove({ force: true, v: true });
      if (group) await runtime.docker.getNetwork(group.id).remove();
      await runtime.dispose();
    }
    setDefaultEdgeImage(undefined);
  }, 30_000);
  it("balances private traffic, keeps member ports private and exposes one workload", async () => {
    const responses = await request(12);
    expect(new Set(responses.map((row) => row.id)).size).toBe(3);
    expect(responses.every((row) => row.version === "one")).toBe(true);
    const rows = await inventory();
    expect(rows).toHaveLength(4);
    for (const row of rows)
      expect((await runtime.docker.getContainer(row.Id).inspect()).HostConfig.PortBindings).toEqual(
        {},
      );
    expect(await runtime.status(ref)).toMatchObject({ desired: 3, ready: 3 });
    expect(await runtime.listDeploymentContainers("first")).toEqual([
      expect.objectContaining({ containerId: ref, status: "running", serviceName: "api" }),
    ]);
    expect((await runtime.listAllContainers()).find((row) => row.id === ref)?.image).toBe(
      "node:24-bookworm",
    );
    expect(await runtime.readinessTargets(ref)).toHaveLength(3);
  });
  it("routes around a stopped member and resumes all instances through the existing start flow", async () => {
    const rows = await instances();
    await runtime.docker.getContainer(rows[1]!.Id).stop();
    expect(await runtime.status(ref)).toMatchObject({ desired: 3, ready: 2 });
    expect(new Set((await request(9)).map((row) => row.id)).size).toBe(2);
    await runtime.start(ref);
    expect(await runtime.status(ref)).toMatchObject({ ready: 3 });
    expect(new Set((await request(12)).map((row) => row.id)).size).toBe(3);
  }, 30_000);
  it("applies environment changes to every instance while keeping the workload identity", async () => {
    const callbacks: string[] = [];
    await runtime.applyEnvironment(
      ref,
      { VERSION: "two" },
      {
        projectId,
        serviceName: "api",
        onReplaced: async (result) => {
          callbacks.push(result.containerId);
        },
      },
    );
    expect(callbacks).toEqual([ref]);
    expect((await request(12)).every((row) => row.version === "two")).toBe(true);
    expect(await runtime.status(ref)).toMatchObject({ desired: 3, ready: 3 });
    expect(
      (await runtime.getRuntimeLogs(ref, 30)).some((row) => /\[instance \d\]/.test(row.message)),
    ).toBe(true);
  }, 90_000);
  it("restores every changed member after a partial environment failure", async () => {
    let recorded = false;
    await expect(
      runtime.applyEnvironment(
        ref,
        { VERSION: "bad", FAIL_INSTANCE: "1" },
        {
          projectId,
          serviceName: "api",
          onReplaced: async () => {
            recorded = true;
          },
        },
      ),
    ).rejects.toThrow();
    expect(recorded).toBe(false);
    expect((await request(12)).every((row) => row.version === "two")).toBe(true);
    expect(await runtime.status(ref)).toMatchObject({ desired: 3, ready: 3 });
    expect(await inventory()).toHaveLength(4);
  }, 90_000);
  it("connects and disconnects the whole workload through shared service networking", async () => {
    const slug = `${projectId}-consumer`;
    try {
      await runtime.joinServiceGroupContainers(
        slug,
        [{ containerId: ref, aliases: ["shared-api"] }],
        { strict: true },
      );
      expect(
        Object.keys(
          (await runtime.docker.getNetwork(`openship-${slug}`).inspect()).Containers ?? {},
        ),
      ).toHaveLength(4);
      expect(new Set((await request(9, "shared-api")).map((row) => row.id)).size).toBe(3);
    } finally {
      await runtime.leaveServiceGroupContainers(slug, [ref]);
    }
    for (const row of await inventory())
      expect(Object.keys(row.NetworkSettings.Networks)).not.toContain(`openship-${slug}`);
    expect(await runtime.status(ref)).toMatchObject({ ready: 3 });
  });
  it("cleans an unsuccessful replacement and preserves the running workload", async () => {
    const failed = {
      ...config,
      deploymentId: "failure",
      advanced: { ...config.advanced, entrypoint: ["/executable-that-does-not-exist"] },
    };
    await expect(runtime.deployServiceWorkload(group, failed)).rejects.toThrow();
    expect(
      (await inventory()).filter((row) => row.Labels["openship.deployment"] === "failure"),
    ).toHaveLength(0);
    expect(await runtime.status(ref)).toMatchObject({ ready: 3 });
  });
  it("shares read-only data and keeps named-volume inventory available for cleanup", async () => {
    const volume = `${projectId}-readonly`;
    let readonlyRef: string | undefined;
    await runtime.docker.createVolume({ Name: volume, Labels: { "openship.project": projectId } });
    try {
      readonlyRef = (
        await runtime.deployServiceWorkload(group, {
          ...config,
          deploymentId: "readonly",
          serviceName: "readonly",
          replicas: 2,
          volumes: [`${volume}:/data:ro`],
          namespaceVolumes: false,
        })
      ).containerId;
      expect(await runtime.inspectNamedVolumes(readonlyRef)).toEqual([volume]);
      expect(await runtime.status(readonlyRef)).toMatchObject({ ready: 2 });
      for (const row of (await inventory()).filter(
        (row) =>
          row.Labels["openship.deployment"] === "readonly" &&
          row.Labels[REPLICA_INDEX_LABEL] !== "0",
      )) {
        expect((await runtime.docker.getContainer(row.Id).inspect()).Mounts).toContainEqual(
          expect.objectContaining({ Name: volume, RW: false }),
        );
      }
    } finally {
      if (readonlyRef) await runtime.destroy(readonlyRef);
      await runtime.docker.getVolume(volume).remove();
    }
  });
  it("rechecks ownership, refuses unsupported runtimes and cancels before creation", async () => {
    const denied = new DockerReplicas({ supports: () => false } as unknown as DockerRuntime);
    await expect(denied.members(ref)).rejects.toMatchObject({
      code: "WORKLOAD_REPLICAS_UNSUPPORTED",
    });
    await expect(
      runtime.applyEnvironment(
        ref,
        {},
        { projectId: "another-project", serviceName: "api", onReplaced: async () => {} },
      ),
    ).rejects.toMatchObject({ code: "WORKLOAD_OWNERSHIP_CHANGED" });
    runtime.setOperationSignal(AbortSignal.abort());
    await expect(
      runtime.deployServiceWorkload(group, { ...config, deploymentId: "cancelled" }),
    ).rejects.toThrow();
    runtime.setOperationSignal(new AbortController().signal);
    expect(
      (await inventory()).some((row) => row.Labels["openship.deployment"] === "cancelled"),
    ).toBe(false);
  });
  it("uses the same group lifecycle for a primary application and keeps its published port on loopback", async () => {
    const deployed = await runtime.deploy({
      projectId,
      deploymentId: "primary",
      buildSessionId: "primary",
      slug: projectId,
      networkAlias: "site",
      imageRef: config.image,
      environment: "production",
      port: 8080,
      replicas: 2,
      resources: { cpuCores: 0.25, memoryMb: 128, diskMb: 0 },
      envVars: { VERSION: "primary" },
      startCommand: `exec node -e ${sq(app)}`,
      restartPolicy: "always",
    });
    const primaryRef = deployed.containerId!;
    try {
      expect(await runtime.status(primaryRef)).toMatchObject({ desired: 2, ready: 2 });
      expect(new Set((await request(8, "site")).map((row) => row.id)).size).toBe(2);
      const info = await runtime.getContainerInfo(primaryRef);
      expect(info.hostPort).toBeGreaterThan(0);
      expect(info.resources).toMatchObject({ cpuCores: 0.5, memoryMb: 256 });
      const detail = await runtime.inspectContainer(primaryRef);
      expect(detail?.env).toContain("VERSION=primary");
      expect(detail?.image).toBe(config.image);
      expect(detail?.ports).toContainEqual(
        expect.objectContaining({ privatePort: 8080, publicPort: info.hostPort, ip: "127.0.0.1" }),
      );
      expect(detail?.networkAddresses).toContain(info.ip);
      const rows = (await inventory()).filter(
        (row) => row.Labels["openship.deployment"] === "primary",
      );
      for (const row of rows) {
        const bindings = (await runtime.docker.getContainer(row.Id).inspect()).HostConfig
          .PortBindings;
        if (row.Labels[REPLICA_INDEX_LABEL] === "0")
          expect(bindings["8080/tcp"]).toEqual([expect.objectContaining({ HostIp: "127.0.0.1" })]);
        else expect(bindings).toEqual({});
      }
    } finally {
      await runtime.destroy(primaryRef);
    }
  });
  it("scales down to an ordinary container and removes every old member", async () => {
    await runtime.stop(ref);
    expect(await runtime.status(ref)).toMatchObject({ ready: 0 });
    const one = await runtime.deployServiceWorkload(group, {
      ...config,
      replicas: 1,
      deploymentId: "single",
      previousContainerId: ref,
    });
    expect(one.containerId).not.toMatch(/^replicas:/);
    await runtime.destroy(ref);
    const rows = await inventory();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.Labels[REPLICA_GROUP_LABEL]).toBeUndefined();
    expect(await runtime.getContainerInfo(ref)).toMatchObject({ status: "missing" });
  });
});
