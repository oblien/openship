import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { DockerRuntime, type DeployConfig, type ReleaseCommandOptions } from "@repo/adapters";
import { runReleasePhase } from "@repo/platform/engine/modules/deployments/release-phase";
import { describeDockerE2E, requireDocker, dockerSocketPath } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const projectId = `release-e2e-${process.pid}`;
const slug = projectId;
const sourceName = `${slug}-database`;
const externalNetwork = `openship-${sourceName}`;
const volume = `openship-${slug}-data`;
const baseImage = "busybox:1.37";
const image = `openship-release-e2e:${process.pid}`;
let runtime: DockerRuntime;
let liveContainer: string;
const scratchVolumes = new Set<string>();
const liveVolumes = new Map<string, string>();

async function docker(...args: string[]): Promise<string> {
  return (await exec("docker", ["--host", `unix://${dockerSocketPath}`, ...args], { timeout: 120_000 })).stdout.trim();
}
function config(deploymentId: string): DeployConfig {
  return {
    projectId, slug, runtimeName: slug, networkAlias: "app", deploymentId,
    buildSessionId: "release-e2e", imageRef: image, environment: "production", port: 8080,
    startCommand: "mkdir -p /tmp/www; printf live > /tmp/www/index.html; exec httpd -f -p 8080 -h /tmp/www",
    envVars: { MIGRATION_VALUE: "production-value" },
    resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
    volumes: ["data:/app/data"], restartPolicy: "no",
  };
}
async function release(commands: string[], options: ReleaseCommandOptions = {}, onLog = (_message: string) => {}) {
  await runReleasePhase({
    commands, signal: options.signal, log: () => {},
    run: command => runtime.runReleaseCommand(config("candidate"), command, entry => onLog(entry.message), {
      ...options,
      beforeStart: async containerId => {
        const mounts = JSON.parse(await docker("inspect", "--format", "{{json .Mounts}}", containerId));
        for (const mount of mounts) if (mount.Destination === "/scratch") {
          scratchVolumes.add(mount.Name);
          // Image-declared volumes are persistent app data too. A release
          // command must see the exact mount used by the serving application.
          expect(mount.Name).toBe(liveVolumes.get("/scratch"));
        }
        await runtime.attachToExternalNetworks(projectId, [externalNetwork], [], {
          onlyContainerIds: [containerId], strict: true,
        });
        expect(await runtime.listDeploymentContainers("candidate")).toEqual([]);
      },
    }),
  });
}
async function expectLiveAppAndNoReleaseContainer() {
  expect(await docker("exec", liveContainer, "wget", "-qO-", "http://127.0.0.1:8080")).toBe("live");
  const containers = await docker("ps", "-a", "--filter", `label=openship.project=${projectId}`, "--format", "{{.Names}}");
  expect(containers).not.toContain("openship-release-candidate-");
  const remaining = new Set((await docker("volume", "ls", "-q")).split("\n"));
  const persistent = new Set(liveVolumes.values());
  expect([...scratchVolumes].filter(name => remaining.has(name) && !persistent.has(name))).toEqual([]);
  for (const name of persistent) expect(remaining.has(name), `app volume ${name} was removed`).toBe(true);
  const networks = await docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", liveContainer);
  expect(networks).not.toContain(externalNetwork);
}

describeDockerE2E("release commands against Docker", () => {
  beforeAll(async () => {
    await requireDocker();
    await docker("pull", baseImage);
    const source = await mkdtemp(join(tmpdir(), "openship-release-image-"));
    try {
      await writeFile(join(source, "Dockerfile"), `FROM ${baseImage}\nWORKDIR /app\nVOLUME /scratch\n`);
      await docker("build", "-t", image, source);
    } finally { await rm(source, { recursive: true, force: true }); }
    runtime = await DockerRuntime.create({ transport: "socket", dockerSocketPath });
    await docker("network", "create", externalNetwork);
    await docker("run", "-d", "--name", sourceName, "--network", externalNetwork, "--network-alias", "database",
      baseImage, "sh", "-c", "mkdir -p /www; printf database-ready > /www/index.html; exec httpd -f -p 8080 -h /www");
    liveContainer = (await runtime.deploy(config("live"))).containerId!;
    const mounts = JSON.parse(await docker("inspect", "--format", "{{json .Mounts}}", liveContainer));
    for (const mount of mounts) if (mount.Type === "volume") liveVolumes.set(mount.Destination, mount.Name);
    await vi.waitFor(() => expectLiveAppAndNoReleaseContainer());
  });
  afterAll(async () => {
    try {
      const ids = (await docker("ps", "-aq", "--filter", `label=openship.project=${projectId}`)).split("\n").filter(Boolean);
      if (ids.length) await docker("rm", "-fv", ...ids);
      await docker("rm", "-f", sourceName).catch(() => {});
      await docker("volume", "rm", ...new Set([volume, ...scratchVolumes, ...liveVolumes.values()])).catch(() => {});
      await docker("network", "rm", externalNetwork, `openship-${slug}`).catch(() => {});
      await docker("image", "rm", image).catch(() => {});
    } finally { await runtime?.dispose(); }
  });

  it("uses the candidate env, connected-service DNS and shared volume before activation", async () => {
    await release([
      'test "$(wget -qO- http://database:8080)" = database-ready && printf "%s" "$MIGRATION_VALUE" > /app/data/schema',
      'test "$(cat /app/data/schema)" = production-value && printf :migrated >> /app/data/schema',
      'printf image-volume-shared > /scratch/release-proof',
    ]);
    const deployed = await runtime.deploy(config("next"));
    expect(await docker("exec", deployed.containerId!, "cat", "/app/data/schema")).toBe("production-value:migrated");
    expect(await docker("exec", liveContainer, "cat", "/scratch/release-proof")).toBe("image-volume-shared");
    expect(await docker("exec", deployed.containerId!, "cat", "/scratch/release-proof")).toBe("image-volume-shared");
    await expectLiveAppAndNoReleaseContainer();
  });

  it("prevents activation after failure and preserves the live app", async () => {
    const activate = vi.fn();
    await expect(release(["echo migration-failed >&2; exit 7", "echo must-not-run"]).then(activate))
      .rejects.toThrow(/exit code 7[\s\S]*migration-failed/);
    expect(activate).not.toHaveBeenCalled();
    await expectLiveAppAndNoReleaseContainer();
  });

  it("times out a running command and reaps its container", async () => {
    await expect(release(["sleep 60"], { timeoutMs: 800 })).rejects.toThrow(/timed out/);
    await expectLiveAppAndNoReleaseContainer();
  });

  it("cancels from streamed output without leaving a process or stopping the app", async () => {
    const controller = new AbortController();
    await expect(release(["echo release-started; sleep 60"], { signal: controller.signal }, message => {
      if (message.includes("release-started")) controller.abort(new Error("User cancelled"));
    })).rejects.toThrow("User cancelled");
    await expectLiveAppAndNoReleaseContainer();
  });
});
