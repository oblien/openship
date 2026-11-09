/** Real SSH -> Docker builds. The nested daemon owns every image/cache here. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BuildLogger,
  DockerRuntime,
  NoopInfraProvider,
  sq,
  type BuildConfig,
  type LogEntry,
} from "@repo/adapters";
import { repos } from "@repo/db";
import { parseComposeFile } from "@repo/platform/engine/lib/compose-parser";
import { deployComposeServices } from "@repo/platform/engine/modules/deployments/compose/deploy.service";
import { SshExecutor } from "../../../../packages/adapters/src/system/ssh-executor";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { availablePort, sshReady } from "../helpers/migration-host";
import { protectedBuildKitImage } from "../helpers/buildkit-image";
import { seedDeployment, seedOrg, seedProject } from "../helpers/seed";

const run = promisify(execFile);
const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/migration-target");

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 60_000;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error("The isolated SSH/Docker target did not become ready");
}

describeDockerE2E("native Compose build batches", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const image = `openship-native-build-target:${suffix}`;
  let target: string, directory: string;
  let runtime: DockerRuntime;
  let executor: SshExecutor;
  let connection: ConstructorParameters<typeof SshExecutor>[0];
  const logs: LogEntry[] = [];
  const logger = () => new BuildLogger((entry) => logs.push(entry));

  beforeAll(async () => {
    await requireDocker();
    directory = await mkdtemp(join(tmpdir(), "openship-native-build-"));
    const identity = join(directory, "identity");
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity]);
    await run("docker", ["build", "-q", "-t", image, fixture], { timeout: 300_000 });
    const port = await availablePort();
    target = // Nested CPU/RAM controls need a domain-capable cgroup hierarchy.
      (
        await run("docker", [
          "create",
          "--privileged",
          "--cgroupns=host",
          "-p",
          `127.0.0.1:${port}:22`,
          image,
        ])
      ).stdout.trim();
    await run("docker", ["cp", `${identity}.pub`, `${target}:/root/.ssh/authorized_keys`]);
    await run("docker", ["start", target]);
    await waitFor(() => sshReady(port));
    connection = {
      host: "127.0.0.1",
      port,
      username: "root",
      privateKey: await readFile(identity, "utf8"),
    };
    executor = new SshExecutor(connection);
    await waitFor(async () => {
      try {
        await executor.exec("docker info >/dev/null", { timeout: 2_000 });
        return true;
      } catch {
        return false;
      }
    });
    runtime = await DockerRuntime.create({
      ...connection,
      transport: "ssh",
      executor,
      nativeBuilds: true,
    });
    const repo = join(directory, "source");
    await mkdir(repo);
    await writeFile(
      join(repo, "Dockerfile"),
      "FROM alpine:3.21\nARG SERVICE\nRUN sleep 2 && echo $SERVICE > /service\nCOPY revision /revision\n",
    );
    await writeFile(join(repo, "revision"), "first\n");
    await run("git", ["init", "-q", repo]);
    await run("git", ["-C", repo, "add", "."]);
    await commit(repo, "fixture");
  }, 360_000);

  afterAll(async () => {
    await runtime?.dispose();
    await executor?.dispose();
    if (target) await run("docker", ["rm", "-f", target]);
    await run("docker", ["image", "rm", "-f", image]).catch(() => {});
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  async function commit(repo: string, message: string) {
    await run("git", [
      "-C",
      repo,
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=E2E",
      "-c",
      "user.email=e2e@example.test",
      "commit",
      "-qm",
      message,
    ]);
  }

  function specs(attempt: string) {
    return ["api", "web", "worker"].map((serviceName) => ({
      serviceName,
      logger: logger(),
      config: {
        sessionId: `native-${suffix}-${attempt}-${serviceName}`,
        projectId: `native-${suffix}`,
        slug: `native-${suffix}-${serviceName}`,
        repoUrl: "",
        branch: "main",
        localPath: join(directory, "source"),
        stack: "docker",
        buildImage: "",
        runtimeImage: "",
        packageManager: "",
        installCommand: "",
        buildCommand: "",
        outputDirectory: "",
        startCommand: "",
        port: 8080,
        envVars: {},
        buildArgs: { SERVICE: serviceName === "worker" ? "api" : serviceName },
        resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
        rootDirectory: ".",
        dockerfilePath: "Dockerfile",
      } as BuildConfig,
    }));
  }

  it("keeps images in the same engine, reuses warm layers and rebuilds changed source", async () => {
    for (const attempt of ["cold", "warm", "changed"]) {
      if (attempt === "changed") {
        const repo = join(directory, "source");
        await writeFile(join(repo, "revision"), "second\n");
        await run("git", ["-C", repo, "add", "."]);
        await commit(repo, "change");
      }
      logs.length = 0;
      const started = Date.now();
      const result = await runtime.buildImages(specs(attempt), logger());
      expect(
        result.map((entry) => entry.result.status),
        JSON.stringify(result),
      ).toEqual(["deploying", "deploying", "deploying"]);
      const output = logs.map((entry) => entry.message).join("\n");
      expect(output).toContain("native Docker BuildKit");
      expect(output).not.toMatch(
        /sending tarball|importing to docker|exporting to docker image format/,
      );
      if (attempt !== "cold") expect(output).toContain("CACHED");
      for (const { serviceName, result: built } of result) {
        const container = await runtime.docker.createContainer({
          Image: built.imageRef,
          Cmd: ["sh", "-c", "cat /service /revision"],
          NetworkDisabled: true,
        });
        try {
          await container.start();
          expect((await container.wait()).StatusCode).toBe(0);
          const proof = String(await container.logs({ stdout: true }));
          expect(proof).toContain(serviceName === "worker" ? "api" : serviceName);
          expect(proof).toContain(attempt === "changed" ? "second" : "first");
        } finally {
          await container.remove({ force: true });
        }
      }
      process.stdout.write(`[native-build] ${attempt}: ${Date.now() - started}ms, three verified images\n`);
    }
    expect(
      (await executor.exec("docker ps -a --filter name=buildx_buildkit --format '{{.ID}}'")).trim(),
    ).toBe("");
  }, 180_000);

  it("finishes sibling builds when one image fails", async () => {
    const repo = join(directory, "source");
    await writeFile(join(repo, "Dockerfile.failure"),
      "FROM alpine:3.21\nARG SERVICE\nRUN if [ \"$SERVICE\" = api ]; then echo expected-build-failure >&2; exit 23; else echo sibling-ready > /proof; fi\n");
    await run("git", ["-C", repo, "add", "."]);
    await commit(repo, "failure fixture");
    const jobs = specs("failure").slice(0, 2).map(job => ({ ...job, config: { ...job.config, dockerfilePath: "Dockerfile.failure" } }));
    const results = await runtime.buildImages(jobs, logger());
    expect(results.map(item => item.result.status)).toEqual(["failed", "deploying"]);
    expect((await runtime.docker.getImage(results[1]!.result.imageRef!).inspect()).Id).toMatch(/^sha256:/);
  });

  it("cancels in-flight and queued batch builds without returning deployable images", async () => {
    const repo = join(directory, "source");
    await writeFile(join(repo, "Dockerfile.cancel"),
      "FROM alpine:3.21\nRUN echo openship-cancel-ready; sleep 30\n");
    await run("git", ["-C", repo, "add", "."]);
    await commit(repo, "cancellation fixture");
    logs.length = 0;
    const jobs = specs("cancel").map(job => ({ ...job, config: { ...job.config, dockerfilePath: "Dockerfile.cancel" } }));
    const pending = runtime.buildImages(jobs, logger());
    try {
      await waitFor(async () => logs.some(entry => /\d+\.\d+ openship-cancel-ready/.test(entry.message)));
    } finally {
      await runtime.cancelBuild(`native-${suffix}-cancel`);
    }
    expect((await pending).map(item => item.result.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
  });

  it("reuses one protected worker for the batch and retains its private cache after cleanup", async () => {
    await runtime.dispose();
    runtime = await DockerRuntime.create({ ...connection, transport: "ssh", executor });
    const repository = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
    const remoteSource = `/tmp/openship-buildkit-source-${suffix}`;
    // Reuse the release fixture builder and exact policy source. This PR's
    // tests must not depend on its worker image already being published.
    for (const file of [
      "packages/adapters/Dockerfile.buildkit",
      "packages/core/src/build-metadata-policy.ts",
      "packages/adapters/scripts/render-buildkit-guard.ts",
    ]) {
      const path = join(remoteSource, file);
      await executor.mkdir(dirname(path));
      await executor.writeFile(path, await readFile(join(repository, file), "utf8"));
    }
    const workerImage = await protectedBuildKitImage(`native-${suffix}`, async (...args) => ({
      stdout: await executor.exec(
        `docker ${args
          .map((arg) =>
            sq(arg.startsWith(repository) ? join(remoteSource, arg.slice(repository.length)) : arg),
          )
          .join(" ")}`,
        { timeout: 300_000 },
      ),
      stderr: "",
    }));
    const commands = vi.spyOn(executor, "exec");
    try {
      const batch = specs("protected");
      for (const spec of batch) spec.config.resources = { cpuCores: 1, memoryMb: 2048, diskMb: 0 };
      const result = await runtime.buildImages(batch, logger());
      expect(
        result.map((entry) => entry.result.status),
        JSON.stringify(result),
      ).toEqual(["deploying", "deploying", "deploying"]);
      expect(
        commands.mock.calls.filter(([command]) => command.startsWith("docker buildx create")),
      ).toHaveLength(1);
      expect(
        (
          await executor.exec("docker ps -a --filter name=buildx_buildkit --format '{{.ID}}'")
        ).trim(),
      ).toBe("");
      expect(
        (
          await executor.exec(
            `docker volume ls --filter label=openship.build-cache.project=native-${suffix} --format '{{.Name}}'`,
          )
        ).trim(),
      ).not.toBe("");
    } finally {
      commands.mockRestore();
      await workerImage.dispose();
    }
  }, 300_000);

  it("honors healthy and completed dependency conditions with real containers", async () => {
    const { organizationId } = await seedOrg();
    const project = await seedProject(organizationId, {
      slug: `conditions-${suffix}`,
      framework: "docker-compose",
      runtimeMode: "docker",
      routeStrategy: "container-ip",
    });
    const parsed = parseComposeFile(`services:
  db:
    image: alpine:3.21
    command: [sh, -c, "sleep 2; touch /tmp/ready; exec sleep 300"]
    healthcheck:
      test: [CMD-SHELL, "test -f /tmp/ready"]
      interval: 1s
      timeout: 1s
      retries: 10
  migrate:
    image: alpine:3.21
    command: [sh, -c, "sleep 1; exit 0"]
    restart: "no"
    depends_on:
      db: { condition: service_healthy }
  app:
    image: alpine:3.21
    command: [echo, dependency-completed]
    restart: "no"
    depends_on:
      migrate: { condition: service_completed_successfully }
`);
    await repos.service.syncFromCompose(project.id, parsed.services, {
      composeAuthoritative: true,
    });
    const persisted = await repos.service.listByProject(project.id);
    expect(
      persisted.find((service) => service.name === "app")?.advanced?.dependsOnConditions,
    ).toEqual({ migrate: "service_completed_successfully" });
    const deployment = await seedDeployment(project, {
      status: "deploying",
      imageRef: "compose",
      containerId: "compose",
    });
    const noop = new NoopInfraProvider();
    const ids = new Map<string, string>();
    const activate = runtime.deployServiceWorkload.bind(runtime);
    const activation = vi
      .spyOn(runtime, "deployServiceWorkload")
      .mockImplementation(async (...args) => {
        const name = args[1].serviceName;
        if (name === "migrate")
          expect((await runtime.sampleStability(ids.get("db")!)).health).toBe("healthy");
        if (name === "app")
          expect((await runtime.sampleStability(ids.get("migrate")!)).exitCode).toBe(0);
        const result = await activate(...args);
        ids.set(name, result.containerId);
        return result;
      });
    const result = await deployComposeServices(project, deployment, runtime, logger(), {
      executor,
      localHost: false,
      routing: noop,
      ssl: noop,
      usesManagedRouting: false,
    }).finally(() => activation.mockRestore());
    expect(result.status, JSON.stringify(result)).toBe("ready");
    await repos.deployment.updateStatus(deployment.id, "ready");
    expect(result.summary.failed, JSON.stringify({ result, logs })).toBe(0);
    const migration = result.services.find((service) => service.serviceName === "migrate")!;
    const app = result.services.find((service) => service.serviceName === "app")!;
    const migrationSample = await runtime.sampleStability(migration.containerId!);
    expect(migrationSample.exitCode, JSON.stringify({ migrationSample, result, logs })).toBe(0);
    expect(
      (await runtime.getRuntimeLogs(app.containerId!, 10)).map((entry) => entry.message).join("\n"),
    ).toContain("dependency-completed");
  }, 60_000);
});
