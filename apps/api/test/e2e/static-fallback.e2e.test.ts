import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Dockerode from "dockerode";
import { DockerRuntime, DEFAULT_RESOURCE_CONFIG } from "@repo/adapters";
import { parseOpenshipConfig } from "@repo/core";
import { CreateProjectBody, parseInput } from "@repo/contracts";
import { createBuildConfig } from "@repo/platform/engine/modules/deployments/build-config";
import { generateDockerfile } from "../../../../packages/adapters/src/runtime/docker-build-plan";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { seedDeployment, seedOrg, seedProject } from "../helpers/seed";
import { freePort } from "../helpers/free-port";

// Manifest -> API contract -> saved project -> production recipe -> real HTTP.
// Both fixtures ship 404.html: its presence must never select the routing policy.
describeDockerE2E("generated static container fallback", () => {
  let runtime: DockerRuntime;
  const directories: string[] = [];
  const images: string[] = [];
  const containers: Dockerode.Container[] = [];
  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage("nginx:alpine");
  });
  afterAll(async () => {
    for (const container of containers) await container.remove({ force: true });
    for (const image of images)
      await runtime.docker
        .getImage(image)
        .remove({ force: true })
        .catch(() => {});
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
    await runtime?.dispose();
  });

  it.each([undefined, false])(
    "serves the configured fallback (%s) and preserves real files",
    async (spaFallback) => {
      const { config: manifest, errors } = parseOpenshipConfig({ routes: { spaFallback } });
      expect(errors).toEqual([]);
      const input = parseInput(CreateProjectBody, {
        name: "Static site",
        routingConfig: manifest?.routes,
      });
      const org = await seedOrg();
      const project = await seedProject(org.organizationId, input);
      const dep = await seedDeployment(project);
      const config = createBuildConfig({
        project,
        dep,
        sessionId: randomUUID(),
        envVars: {},
        resources: DEFAULT_RESOURCE_CONFIG,
        snapshot: {
          repoUrl: "",
          branch: "main",
          framework: "static",
          buildImage: "nginx:alpine",
          runtimeImage: "",
          packageManager: "",
          installCommand: "",
          buildCommand: "",
          outputDirectory: "public",
          productionPaths: [],
          rootDirectory: "",
          port: 8080,
          startCommand: "",
          hasServer: false,
          hasBuild: false,
        },
        overrides: { isStatic: true },
      });
      const directory = await mkdtemp(join(tmpdir(), "openship-static-fallback-"));
      directories.push(directory);
      await mkdir(join(directory, "public"));
      await writeFile(join(directory, "public/index.html"), "SPA-INDEX");
      await writeFile(join(directory, "public/404.html"), "CUSTOM-NOT-FOUND");
      await writeFile(join(directory, "public/asset.js"), "STATIC-ASSET");
      await writeFile(join(directory, "Dockerfile"), generateDockerfile(config));
      const image = `openship-static-fallback:${randomUUID()}`;
      images.push(image);
      const stream = await runtime.docker.buildImage(
        { context: directory, src: ["Dockerfile", "public"] },
        { t: image },
      );
      await new Promise<void>((resolve, reject) =>
        runtime.docker.modem.followProgress(stream, (error: Error | null) =>
          error ? reject(error) : resolve(),
        ),
      );
      const port = await freePort();
      const container = await runtime.docker.createContainer({
        Image: image,
        ExposedPorts: { "8080/tcp": {} },
        HostConfig: { PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: port }] } },
      });
      containers.push(container);
      await container.start();
      const url = `http://127.0.0.1:${port}`;
      await expect
        .poll(
          async () => {
            try {
              return (await fetch(url)).status;
            } catch {
              return 0;
            }
          },
          { timeout: 30_000 },
        )
        .toBe(200);
      expect(await (await fetch(`${url}/asset.js`)).text()).toBe("STATIC-ASSET");
      for (const path of ["/dashboard/settings", "/missing.js", "/missing?x=1"]) {
        const response = await fetch(url + path);
        expect(response.status).toBe(spaFallback === false ? 404 : 200);
        expect(await response.text()).toBe(
          spaFallback === false ? "CUSTOM-NOT-FOUND" : "SPA-INDEX",
        );
      }
      const head = await fetch(`${url}/missing`, { method: "HEAD" });
      expect(head.status).toBe(spaFallback === false ? 404 : 200);
      expect(await head.text()).toBe("");
      // Removing a custom page changes only the error body, never the policy.
      const remove = await container.exec({ Cmd: ["rm", "/usr/share/nginx/html/404.html"] });
      await remove.start({ Detach: true });
      await expect.poll(async () => (await remove.inspect()).Running).toBe(false);
      expect((await remove.inspect()).ExitCode).toBe(0);
      const missing = await fetch(`${url}/missing`);
      expect(missing.status).toBe(spaFallback === false ? 404 : 200);
      if (spaFallback === false) expect(await missing.text()).not.toContain("SPA-INDEX");
    },
    300_000,
  );
});
