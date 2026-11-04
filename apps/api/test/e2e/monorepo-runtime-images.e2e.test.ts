import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BuildLogger, DockerRuntime, DEFAULT_RESOURCE_CONFIG } from "@repo/adapters";
import type { Deployment, Project } from "@repo/db";
import { resolveSubAppImages } from "@repo/platform/engine/lib/deployable-service";
import { createMonorepoSourceBuildConfig } from "@repo/platform/engine/modules/deployments/build-config";
import { describeDockerE2E, dockerSocketPath, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const dockerEnv = { ...process.env, DOCKER_HOST: `unix://${dockerSocketPath}` };

describeDockerE2E("monorepo service build and runtime toolchains", () => {
  let runtime: DockerRuntime;
  const dirs: string[] = [],
    images: string[] = [],
    containers: string[] = [];
  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
  });
  afterAll(async () => {
    for (const id of containers)
      await exec("docker", ["rm", "-f", id], { env: dockerEnv }).catch(() => {});
    for (const image of images)
      await exec("docker", ["rmi", "-f", image], { env: dockerEnv }).catch(() => {});
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    await runtime?.dispose();
  });

  it.each(["node", undefined])(
    "builds and serves a Node sub-app (framework=%s)",
    async (framework) => {
      const dir = await mkdtemp(join(tmpdir(), "openship-monorepo-runtime-e2e-"));
      dirs.push(dir);
      const app = join(dir, "apps/web");
      await mkdir(app, { recursive: true });
      await writeFile(
        join(app, "package.json"),
        JSON.stringify({
          private: true,
          scripts: { build: "mkdir -p dist && cp server.cjs dist/server.cjs" },
        }),
      );
      await writeFile(
        join(app, "server.cjs"),
        `
      require('node:http').createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ marker: 'monorepo-runtime-ok', version: process.version }));
      }).listen(3000, '0.0.0.0');
    `,
      );
      const id = `mono-${randomUUID()}`;
      const snapshot = {
        repoUrl: "",
        branch: "main",
        framework: "unknown",
        packageManager: "npm",
        buildImage: "ubuntu:22.04",
        runtimeImage: "ubuntu:22.04",
        localPath: dir,
        installCommand: "",
        buildCommand: "",
        startCommand: "",
        outputDirectory: "",
        productionPaths: [],
        rootDirectory: "",
        port: 3000,
        hasServer: true,
        hasBuild: true,
      };
      const service = { framework, packageManager: "npm", buildImage: "node:22-bookworm-slim" };
      const config = createMonorepoSourceBuildConfig({
        project: { id, slug: id } as Project,
        dep: { branch: "main", trigger: "manual" } as Deployment,
        snapshot,
        sessionId: id,
        envVars: {},
        resources: DEFAULT_RESOURCE_CONFIG,
        overrides: {
          ...resolveSubAppImages(service, snapshot),
          stack: framework ?? "unknown",
          rootDirectory: "apps/web",
          buildCommand: "npm run build",
          startCommand: "node dist/server.cjs",
        },
      });
      const logs: string[] = [];
      const result = await runtime.build(
        config,
        new BuildLogger((entry) => logs.push(entry.message)),
      );
      expect(result.imageRef, logs.join("\n")).toBeTruthy();
      images.push(result.imageRef!);
      const deployed = await runtime.deploy({
        deploymentId: id,
        projectId: id,
        imageRef: result.imageRef!,
        startCommand: config.startCommand,
        stack: config.stack,
        port: 3000,
        envVars: {},
        resources: DEFAULT_RESOURCE_CONFIG,
      } as never);
      containers.push(deployed.containerId!);
      const container = await runtime.docker.getContainer(deployed.containerId!).inspect();
      const port = container.NetworkSettings.Ports["3000/tcp"]![0]!.HostPort;
      await expect
        .poll(
          async () => {
            try {
              const response = await fetch(`http://127.0.0.1:${port}`);
              return response.ok ? await response.json() : null;
            } catch {
              return null;
            }
          },
          { timeout: 30_000 },
        )
        .toEqual({ marker: "monorepo-runtime-ok", version: expect.stringMatching(/^v22\./) });
      const npm = await exec("docker", ["exec", deployed.containerId!, "npm", "--version"], {
        env: dockerEnv,
      });
      expect(npm.stdout.trim()).toMatch(/^\d+\./);
    },
  );
});
