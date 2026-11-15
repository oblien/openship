/** Real HTTP/SDK operations → reviewed source PR → Docker build/deploy → runtime
 * probe. Only GitHub's transport is simulated; no customer repository is changed.
 * The existing security-advisories E2E covers signed-feed/notification reconciliation. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { BuildLogger, DockerRuntime } from "@repo/adapters";
import { matchSecurityAdvisories, SecurityManifestSchema } from "@repo/core";
import { repos } from "@repo/db";
import { buildConfigSnapshot } from "@repo/platform/engine/modules/deployments/build.service";
import { createDockerfileBuildConfig } from "@repo/platform/engine/modules/deployments/build-config";
import {
  parseRuntimeProbe,
  runtimeVersionProbe,
} from "@repo/platform/engine/modules/updates/runtime-probes";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { sourceFixture } from "../helpers/runtime-source";
import { seedDeployment } from "../helpers/seed";
import { parseComposeFile } from "@repo/platform/engine/lib/compose-parser";
import advisories from "../../../../security-advisories.json";

const provider = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@repo/platform/engine/modules/github/github.auth", async (original) => ({
  ...(await original<object>()),
  githubFetch: provider.fetch,
}));
const OLD = "node:22.23.3-alpine",
  PATCHED = "node:22.23.4-alpine";
const manifest = SecurityManifestSchema.parse({
  format: 1,
  revision: 1,
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  advisories: advisories.advisories.filter((a) => a.id === "CVE-2026-111497-node"),
});

describeDockerE2E("source image update survives PR, deployment and a subsequent rebuild", () => {
  let runtime: DockerRuntime;
  let directory = "";
  const containers: string[] = [],
    images: string[] = [];
  const networks = new Set<string>(),
    volumes = new Set<string>();
  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    directory = await mkdtemp(join(tmpdir(), "openship-source-update-"));
    for (const image of [OLD, PATCHED]) await runtime.pullImage(image);
  });
  afterAll(async () => {
    for (const id of containers) await runtime.destroy(id);
    for (const image of new Set(images)) await runtime.removeImage(image);
    for (const id of networks) await runtime.docker.getNetwork(id).remove();
    for (const name of volumes) await runtime.docker.getVolume(name).remove();
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it("changes the source, leaves the old container affected until deployment, and rebuilds the patched runtime", async () => {
    const dockerfile = `# preserve this comment\nFROM ${OLD}\nCOPY server.cjs /server.cjs\nCMD ["node", "/server.cjs"]\n`;
    const f = await sourceFixture({ Dockerfile: dockerfile });
    provider.fetch.mockImplementation(f.fetch);
    await writeFile(
      join(directory, "server.cjs"),
      'require("http").createServer((q,s)=>s.end(process.version+":"+process.env.KEEP)).listen(8080,"127.0.0.1");',
    );
    const buildProject = {
      ...f.project,
      gitProvider: "local",
      localPath: directory,
      framework: "docker",
      hasBuild: true,
      hasServer: true,
    };
    const run = async (content: string) => {
      await writeFile(join(directory, "Dockerfile"), content);
      const deployment = await seedDeployment(f.project, {
        branch: "main",
        status: "building",
        commitSha: f.git.head,
      });
      const logger = new BuildLogger();
      const built = await runtime.build(
        createDockerfileBuildConfig({
          project: buildProject,
          dep: deployment,
          snapshot: buildConfigSnapshot(buildProject),
          sessionId: deployment.id,
          envVars: {},
          resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
        }),
        logger,
      );
      expect(built.status, built.errorMessage).toBe("deploying");
      expect(built.imageRef).toBeTruthy();
      images.push(built.imageRef!);
      const deployed = await runtime.deploy({
        deploymentId: deployment.id,
        projectId: f.project.id,
        buildSessionId: deployment.id,
        imageRef: built.imageRef!,
        environment: "production",
        port: 8080,
        portless: true,
        runtimeName: `source-update-${deployment.id}`,
        envVars: { KEEP: "unchanged" },
        resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
        restartPolicy: "no",
      });
      expect(deployed.containerId).toBeTruthy();
      containers.push(deployed.containerId!);
      const exec = await runtime.inContainerExecutor(deployed.containerId!);
      await expect
        .poll(() => exec.exec("wget -qO- http://127.0.0.1:8080"), { timeout: 15000 })
        .toMatch(/^v22\.23\.[34]:unchanged/);
      const inspect = await runtime.docker.getContainer(deployed.containerId!).inspect();
      for (const [name, network] of Object.entries(inspect.NetworkSettings.Networks ?? {}))
        if (!["bridge", "host", "none"].includes(name)) networks.add(network.NetworkID);
      expect(Object.values(inspect.NetworkSettings.Ports ?? {}).every((binding) => !binding)).toBe(
        true,
      );
      await repos.deployment.updateStatus(deployment.id, "ready", { imageRef: built.imageRef! });
      await repos.deployment.setContainerId(deployment.id, deployed.containerId!, deployed.url);
      return { exec, imageId: inspect.Image };
    };
    const evidence = async (live: Awaited<ReturnType<typeof run>>) =>
      parseRuntimeProbe(await live.exec.exec(runtimeVersionProbe(["node"])), null);
    const old = await run(dockerfile);
    expect(matchSecurityAdvisories(manifest, [], await evidence(old))).toHaveLength(1);
    const source = await f.clients.remote.updates.runtimeSource(f.project.id, {
      path: "Dockerfile",
      format: "dockerfile",
    });
    const edit = {
      path: "Dockerfile",
      format: "dockerfile" as const,
      baseSha: source.baseSha,
      referenceId: source.references[0]!.id,
      image: PATCHED,
    };
    const preview = await f.clients.remote.updates.previewRuntimeSource(f.project.id, edit);
    await f.clients.remote.updates.publishRuntimeSource(f.project.id, {
      ...edit,
      reviewId: preview.reviewId,
      requestId: randomUUID(),
    });
    expect(f.git.proposed.Dockerfile).toBe(dockerfile.replace(OLD, PATCHED));
    expect(matchSecurityAdvisories(manifest, [], await evidence(old))).toHaveLength(1);
    // Materialize the reviewed merge's checkout for the ordinary Docker build path.
    f.git.files = { ...f.git.files, ...f.git.proposed };
    f.git.head = f.git.commit;
    const patched = await run(f.git.files.Dockerfile!);
    expect(await evidence(patched)).toEqual([
      { serviceId: null, runtime: "node", version: "22.23.4" },
    ]);
    expect(matchSecurityAdvisories(manifest, [], await evidence(patched))).toEqual([]);
    expect(patched.imageId).not.toBe(old.imageId);
    const again = await run(f.git.files.Dockerfile!);
    expect(await evidence(again)).toEqual(await evidence(patched));
    console.info(
      "[runtime-source-e2e] confirmed Node 22.23.3 → 22.23.4 → 22.23.4; environment retained, no published ports, old runtime remains affected until deployment",
      { old: old.imageId, patched: patched.imageId },
    );
  });
  it("deploys a Compose image change with the existing service adapter and retains its volume and environment", async () => {
    const command = [
      "node",
      "-e",
      'require("http").createServer((q,s)=>s.end(process.version+":"+process.env.KEEP)).listen(8080,"127.0.0.1")',
    ];
    const source = `# existing stack\nservices:\n  api:\n    image: '${OLD}' # selected version\n    command: ${JSON.stringify(command)}\n    environment: {KEEP: unchanged}\n    volumes: [data:/data]\n  db:\n    image: postgres:16-alpine\nvolumes:\n  data: {}\n`;
    const f = await sourceFixture({ "compose.yml": source });
    provider.fetch.mockImplementation(f.fetch);
    const networkId = await runtime.ensureNetwork(f.project.slug);
    networks.add(networkId);
    const start = async (content: string) => {
      const service = parseComposeFile(content).services.find((s) => s.name === "api")!;
      const deployed = await runtime.deployService({
        deploymentId: randomUUID(),
        projectId: f.project.id,
        slug: f.project.slug,
        networkId,
        serviceName: service.name,
        image: service.image!,
        environment: service.environment,
        commandArgv: service.commandArgv,
        ports: [],
        volumes: service.volumes,
        namespaceVolumes: true,
        expose: false,
      });
      if (!containers.includes(deployed.containerId)) containers.push(deployed.containerId);
      const inspect = await runtime.docker.getContainer(deployed.containerId).inspect();
      for (const mount of inspect.Mounts ?? [])
        if (mount.Type === "volume" && mount.Name) volumes.add(mount.Name);
      expect(Object.values(inspect.NetworkSettings.Ports ?? {}).every((binding) => !binding)).toBe(
        true,
      );
      const exec = await runtime.inContainerExecutor(deployed.containerId);
      await expect
        .poll(() => exec.exec("wget -qO- http://127.0.0.1:8080"), { timeout: 15000 })
        .toMatch(/^v22\.23\.[34]:unchanged/);
      return { id: deployed.containerId, exec };
    };
    const before = await start(source);
    await before.exec.exec("printf retained-data > /data/check");
    const edit = {
      path: "compose.yml",
      format: "compose" as const,
      baseSha: f.git.head,
      referenceId: "service:api",
      image: PATCHED,
    };
    const preview = await f.clients.remote.updates.previewRuntimeSource(f.project.id, edit);
    await f.clients.remote.updates.publishRuntimeSource(f.project.id, {
      ...edit,
      reviewId: preview.reviewId,
      requestId: randomUUID(),
    });
    expect(f.git.proposed["compose.yml"]).toBe(source.replace(OLD, PATCHED));
    expect(await before.exec.exec("node --version")).toContain("22.23.3");
    // Service replacement uses the adapter's ordinary cutover and volume naming.
    const after = await start(f.git.proposed["compose.yml"]!);
    containers.splice(containers.indexOf(before.id), 1);
    expect(await after.exec.exec("node --version")).toContain("22.23.4");
    expect(await after.exec.exec("cat /data/check")).toBe("retained-data");
    expect(await after.exec.exec("printenv KEEP")).toContain("unchanged");
  });
});
