import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getStackDefaults } from "@repo/core";
import {
  DockerRuntime,
  BuildLogger,
  DEFAULT_RESOURCE_CONFIG,
  type BuildConfig,
} from "@repo/adapters";
import { generateDockerfile } from "../../../../packages/adapters/src/runtime/docker-build-plan";
import { describeDockerE2E, dockerSocketPath, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const dockerEnv = {
  ...process.env,
  DOCKER_HOST: `unix://${dockerSocketPath}`,
  DOCKER_BUILDKIT: "1",
};
describeDockerE2E("managed deployment output and build environment", () => {
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
  async function build(files: Record<string, string>, input: Partial<BuildConfig>) {
    const dir = await mkdtemp(join(tmpdir(), "openship-automation-e2e-"));
    dirs.push(dir);
    const image = `openship-automation-e2e:${randomUUID()}`;
    images.push(image);
    const defaults = getStackDefaults("nextjs", "bun");
    const config = {
      stack: "nextjs",
      buildImage: defaults.buildImage,
      runtimeImage: defaults.runtimeImage,
      packageManager: "bun",
      rootDirectory: "apps/web",
      startCommand: "next start",
      buildCommand: "bun run build",
      installCommand: "",
      workspacePrepareCommand: "bun install",
      port: 3000,
      envVars: {
        NEXT_PUBLIC_MARKER: "build-public-value",
        BUILD_TOKEN: "build-only-proof",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      buildCache: true,
      projectId: "preview-e2e",
      sessionId: randomUUID(),
      resources: DEFAULT_RESOURCE_CONFIG,
      ...input,
    } as BuildConfig;
    for (const [file, content] of Object.entries({
      ...files,
      ".fixture-id": randomUUID(),
      Dockerfile: generateDockerfile(config),
    })) {
      await mkdir(dirname(join(dir, file)), { recursive: true });
      await writeFile(join(dir, file), content);
    }
    const result = await exec("docker", ["build", "--progress=plain", "-t", image, dir], {
      env: dockerEnv,
      timeout: 600_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { image, dir, config, output: result.stdout + result.stderr };
  }
  it("builds a Bun workspace, starts Next standalone through the real runtime and serves public/static assets", async () => {
    const result = await build(
      {
        "package.json": JSON.stringify({
          private: true,
          packageManager: "bun@1.3.14",
          workspaces: ["apps/*", "packages/*"],
        }),
        "packages/shared/package.json": JSON.stringify({
          name: "@fixture/shared",
          version: "1.0.0",
          main: "index.js",
        }),
        "packages/shared/index.js": "module.exports = 'workspace-dependency';",
        "apps/web/package.json": JSON.stringify({
          name: "web",
          private: true,
          scripts: {
            build:
              "node -e \"if(process.env.BUILD_TOKEN !== 'build-only-proof') process.exit(1)\" && next build --webpack",
            start: "next start",
          },
          dependencies: {
            "@fixture/shared": "workspace:*",
            next: "16.1.6",
            react: "19.2.4",
            "react-dom": "19.2.4",
          },
        }),
        "apps/web/next.config.js":
          "const path = require('node:path'); module.exports = { output: 'standalone', outputFileTracingRoot: path.join(__dirname, '../..'), experimental: { cpus: 1 } };",
        "apps/web/pages/index.js":
          "import shared from '@fixture/shared'; export default function Home({ runtime, pid }) { return <main><h1>{process.env.NEXT_PUBLIC_MARKER}</h1><p>{shared}</p><p>{runtime}</p><p id=\"app-pid\">{pid}</p></main>; } export function getServerSideProps(){ return {props:{runtime:process.env.RUNTIME_MARKER,pid:process.pid}}; }",
        "apps/web/public/proof.txt": "public-asset-proof",
        "apps/web/.env.example": "MISSING_EXAMPLE=\nBUILD_TOKEN=\n",
      },
      {},
    );
    expect(result.output).toContain("MISSING_EXAMPLE");
    const deploy = await runtime.deploy({
      deploymentId: randomUUID(),
      projectId: "preview-e2e",
      imageRef: result.image,
      startCommand: "next start",
      stack: "nextjs",
      port: 3000,
      envVars: {
        RUNTIME_MARKER: "runtime-value",
        NEXT_PUBLIC_MARKER: "runtime-must-not-replace-build",
        HOSTNAME: "0.0.0.0",
      },
      resources: DEFAULT_RESOURCE_CONFIG,
    } as never);
    containers.push(deploy.containerId!);
    const container = await runtime.docker.getContainer(deploy.containerId!).inspect();
    expect(container.Config.Cmd).toEqual(["sh", "-c", "exec sh .openship-start.sh"]);
    const port = container.NetworkSettings.Ports["3000/tcp"]![0]!.HostPort;
    const url = `http://127.0.0.1:${port}`;
    let html = "";
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch(url);
            html = await response.text();
            return response.status;
          } catch {
            return 0;
          }
        },
        { timeout: 30_000 },
      )
      .toBe(200);
    expect(html).toContain("build-public-value");
    expect(html).toContain("workspace-dependency");
    expect(html).toContain("runtime-value");
    expect(html).toContain('<p id="app-pid">1</p>');
    expect(html).not.toContain("runtime-must-not-replace-build");
    expect(await (await fetch(`${url}/proof.txt`)).text()).toBe("public-asset-proof");
    const asset = html.match(/src="([^" ]*\/_next\/static\/[^" ]+\.js)"/)?.[1];
    expect(asset).toBeTruthy();
    expect((await fetch(url + asset)).status).toBe(200);
    const warm = await exec(
      "docker",
      ["build", "--progress=plain", "-t", result.image, result.dir],
      { env: dockerEnv, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
    );
    const logger = new BuildLogger();
    logger.observeBuildOutput(warm.stdout + warm.stderr);
    expect(logger.cacheSummary()).toMatch(/[1-9]\d* hit/);
    const application = runtime.docker.getContainer(deploy.containerId!);
    await application.stop({ t: 10 });
    expect([0, 143]).toContain((await application.inspect()).State.ExitCode);
  }, 600_000);

  it("injects the same project environment and managed cache metadata for Python", async () => {
    const result = await build(
      {
        "main.py": "import os; print(os.environ['RUNTIME_MARKER'])",
        ".env.example": "MISSING_PYTHON=\nBUILD_TOKEN=\n",
      },
      {
        stack: "django",
        packageManager: "pip",
        rootDirectory: "",
        workspacePrepareCommand: "",
        buildImage: "python:3.12-slim",
        runtimeImage: "python:3.12-slim",
        startCommand: "python main.py",
        buildCommand:
          "python -c \"import os; assert os.environ['BUILD_TOKEN'] == 'build-only-proof'\"",
      },
    );
    expect(result.output).toContain("MISSING_PYTHON");
    const labels = (await runtime.docker.getImage(result.image).inspect()).Config.Labels;
    expect(JSON.parse(labels["io.openship.build-cache-targets"])).toContain("/root/.cache/pip");
    const run = await exec(
      "docker",
      ["run", "--rm", "-e", "RUNTIME_MARKER=python-runtime", result.image],
      { env: dockerEnv },
    );
    expect(run.stdout.trim()).toBe("python-runtime");
  }, 300_000);
});
