import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { promisify } from "node:util";

import Dockerode from "dockerode";
import { afterAll, describe, expect, it, vi } from "vitest";

import { statusResponse } from "../../test/fixtures/docker-buildkit";
import type { BuildConfig, CommandExecutor } from "../types";

import { BuildLogger } from "./build-pipeline";
import { DockerRuntime } from "./docker";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];

/**
 * Entry names in an uncompressed tar. Substring-matching the raw archive is not good
 * enough: a `.dockerignore` LISTS the very names being asserted about, so its own
 * contents read as entries that are not there.
 */
function tarEntries(archive: Buffer): string[] {
  const names: string[] = [];
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    // "ustar" at 257 marks a header block; anything else is padding or the end.
    if (header.subarray(257, 262).toString("latin1") !== "ustar") {
      offset += 512;
      continue;
    }
    const name = header.subarray(0, 100).toString("latin1").replace(/\0.*$/, "");
    const size = parseInt(
      header.subarray(124, 136).toString("latin1").replace(/\0.*$/, "").trim() || "0",
      8,
    );
    if (name) names.push(name.replace(/\/$/, ""));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names.sort();
}

afterAll(async () => {
  await Promise.all(cleanups.map((fn) => fn().catch(() => {})));
});

/**
 * #634 at the BUILDER boundary. The resolver tests prove the context is computed
 * correctly; these prove it actually reaches docker — the exact place the bug lived.
 * Both builder paths are covered because they are independent implementations of the
 * same decision (the repo's standing "two executors" trap): the SSH path passes the
 * context as a `cd` target, the dockerode path passes it as the tar root.
 */

/** A repo with a self-contained `svc/` service dir and a decoy root Dockerfile. */
async function makeRepo(
  dockerfile = "FROM python:3.12\nCOPY requirements.txt /\n",
): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "dbsc-repo-"));
  cleanups.push(() => rm(repo, { recursive: true, force: true }));

  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await exec("git", ["-C", repo, "config", "commit.gpgsign", "false"]);

  await writeFile(join(repo, "Dockerfile"), "FROM node:22\n");
  await writeFile(join(repo, "root-only.txt"), "root\n");
  await mkdir(join(repo, "svc"), { recursive: true });
  await writeFile(join(repo, "svc", "Dockerfile.api"), dockerfile);
  await writeFile(join(repo, "svc", "requirements.txt"), "flask\n");

  await exec("git", ["-C", repo, "add", "-A", "-f"]);
  await exec("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  return repo;
}

function serviceConfig(localPath: string, overrides: Partial<BuildConfig> = {}): BuildConfig {
  return {
    sessionId: "sess-svc",
    projectId: "p1",
    slug: "app-svc",
    repoUrl: "",
    branch: "main",
    localPath,
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
    resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
    rootDirectory: "svc",
    buildContextDirectory: "svc",
    dockerfilePath: "Dockerfile.api",
    ...overrides,
  } as BuildConfig;
}

function runtimeFor(
  transport: { kind: "ssh" | "local" | "socket" | "tcp"; description: string },
  extra: Record<string, unknown>,
) {
  const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime & Record<string, unknown>;
  Object.assign(runtime, {
    transport,
    systemManager: null,
    ensureDockerFeature: vi.fn(async () => {}),
    verifyImageBuilt: vi.fn(async () => {}),
    estimateContextSize: vi.fn(async () => 1024),
    ...extra,
  });
  return runtime;
}

function spec(config: BuildConfig, logger = new BuildLogger(() => {})) {
  return {
    config,
    serviceName: "api",
    logger,
    requireRepositoryDockerfile: true,
  };
}

describe("remote docker build — declared build context (#634)", () => {
  it("runs docker build INSIDE the service directory with a context-relative -f", async () => {
    const commands: string[] = [];
    const logs: string[] = [];
    const executor: CommandExecutor = {
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        // No buildx on this fake host, so the legacy builder stays selected.
        return "";
      }),
      streamExec: vi.fn(async (command: string) => {
        commands.push(command);
        return { code: 0, output: "" };
      }),
      writeFile: vi.fn(async () => {}),
    } as unknown as CommandExecutor;

    const transferBuildContext = vi.fn(async () => {});
    const runtime = runtimeFor(
      { kind: "ssh", description: "test ssh" },
      { connectionOptions: { executor }, transferBuildContext },
    );

    const results = await runtime.buildImages(
      [
        spec(
          serviceConfig(await makeRepo(), { buildArgs: { APP_PACKAGE: "@myorg/api" } }),
          new BuildLogger((entry) => logs.push(entry.message)),
        ),
      ],
      new BuildLogger((entry) => logs.push(entry.message)),
    );

    expect(results[0]!.result.status).toBe("deploying");

    const buildCmd = commands.find((c) => /docker build\b/.test(c) && c.includes(" -t "))!;
    expect(buildCmd).toBeDefined();
    // The context is the SERVICE dir, so `.` means `svc` and the Dockerfile path is
    // relative to it. A tree-root `cd` plus `-f svc/Dockerfile.api` is the bug.
    expect(buildCmd).toMatch(/cd '\/tmp\/openship-build-sess-svc\/svc' &&/);
    expect(buildCmd).toContain("-f 'Dockerfile.api'");
    expect(buildCmd).not.toContain("svc/Dockerfile.api");
    expect(buildCmd.trimEnd().endsWith(" .")).toBe(true);
    expect(buildCmd).toContain("--build-arg 'APP_PACKAGE=@myorg/api'");
    expect(logs.join("\n")).toContain("values hidden");
    expect(logs.join("\n")).not.toContain("@myorg/api");

    // The whole TREE still ships: one transfer is shared by every service in a batch.
    expect(transferBuildContext).toHaveBeenCalledWith(
      expect.stringContaining("openship-docker-context-"),
      "/tmp/openship-build-sess-svc",
      expect.anything(),
    );
  });

  it("keeps the tree root as the context when no context is declared", async () => {
    const commands: string[] = [];
    const executor: CommandExecutor = {
      exec: vi.fn(async () => ""),
      streamExec: vi.fn(async (command: string) => {
        commands.push(command);
        return { code: 0, output: "" };
      }),
      writeFile: vi.fn(async () => {}),
    } as unknown as CommandExecutor;

    const runtime = runtimeFor(
      { kind: "ssh", description: "test ssh" },
      { connectionOptions: { executor }, transferBuildContext: vi.fn(async () => {}) },
    );

    await runtime.buildImages(
      [
        spec(
          serviceConfig(await makeRepo(), {
            buildContextDirectory: undefined,
            rootDirectory: "",
            dockerfilePath: undefined,
          }),
        ),
      ],
      new BuildLogger(() => {}),
    );

    const buildCmd = commands.find((c) => /docker build\b/.test(c) && c.includes(" -t "))!;
    expect(buildCmd).toMatch(/cd '\/tmp\/openship-build-sess-svc' &&/);
  });

  async function buildCommandWithProbeOutput(probeOutput: string): Promise<string> {
    const commands: string[] = [];
    const executor: CommandExecutor = {
      exec: vi.fn(async (command: string) =>
        command.includes("buildx version") ? probeOutput : "",
      ),
      streamExec: vi.fn(async (command: string) => {
        commands.push(command);
        return { code: 0, output: "" };
      }),
      writeFile: vi.fn(async () => {}),
    } as unknown as CommandExecutor;

    const runtime = runtimeFor(
      { kind: "ssh", description: "test ssh" },
      { connectionOptions: { executor }, transferBuildContext: vi.fn(async () => {}) },
    );
    await runtime.buildImages([spec(serviceConfig(await makeRepo()))], new BuildLogger(() => {}));

    return commands.find((c) => /docker build\b/.test(c) && c.includes(" -t "))!;
  }

  it("opts into BuildKit when the host answers the probe", async () => {
    const buildCmd = await buildCommandWithProbeOutput("OPENSHIP_BUILDKIT_OK\n");

    expect(buildCmd).toContain("DOCKER_BUILDKIT=1 docker build");
    // `--progress` is a buildx flag; `--force-rm` is a legacy one. Each belongs to
    // exactly one builder.
    expect(buildCmd).toContain("--progress=plain");
    expect(buildCmd).not.toContain("--force-rm");
    expect(buildCmd).not.toContain("--add-host");
  });

  it("keeps the legacy builder — and drops --progress — when the probe is unanswered", async () => {
    // The flag matters more than the builder here: a docker CLI without buildx
    // REJECTS `--progress` outright (`unknown flag`, exit 125) before it reads the
    // context, so passing it would fail every build on such a host.
    const buildCmd = await buildCommandWithProbeOutput("");

    expect(buildCmd).not.toContain("DOCKER_BUILDKIT=1");
    expect(buildCmd).not.toContain("--progress");
    expect(buildCmd).toContain("--force-rm");
    expect(buildCmd).toMatch(/--add-host 'openship-build-[0-9a-f-]+\.invalid:127\.0\.0\.1'/);
  });

  it("does not read a version banner as buildx", async () => {
    // A false positive is FATAL (BuildKit without buildx hard-errors), so only the
    // sentinel counts — not a login banner, a wrapper's help text, or a plain
    // `docker buildx version` string that a shell rc-file happened to echo.
    const buildCmd = await buildCommandWithProbeOutput("github.com/docker/buildx v0.17.1 abc123\n");

    expect(buildCmd).not.toContain("DOCKER_BUILDKIT=1");
    expect(buildCmd).toContain("--force-rm");
  });
});

describe("mixed batch — one tree, different contexts (#634)", () => {
  /** A repo whose root `.dockerignore` would delete the service dir outright, plus a
   *  root-context service and a subdir-context service that share one clone. */
  async function makeMixedRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "dbsc-mixed-"));
    cleanups.push(() => rm(repo, { recursive: true, force: true }));

    await exec("git", ["-C", repo, "init", "-q"]);
    await exec("git", ["-C", repo, "config", "user.email", "t@example.com"]);
    await exec("git", ["-C", repo, "config", "user.name", "Test"]);
    await exec("git", ["-C", repo, "config", "commit.gpgsign", "false"]);

    // Written for the ROOT app: `api` is not part of ITS image, and `secret.txt`
    // must stay out of both.
    await writeFile(join(repo, ".dockerignore"), "api\nsecret.txt\n");
    await writeFile(join(repo, "Dockerfile"), "FROM node:22\nCOPY web /web\n");
    await writeFile(join(repo, "secret.txt"), "shhh\n");
    await mkdir(join(repo, "web"), { recursive: true });
    await writeFile(join(repo, "web", "index.html"), "<html/>\n");
    await mkdir(join(repo, "api"), { recursive: true });
    await writeFile(join(repo, "api", "Dockerfile"), "FROM python:3.12\nCOPY requirements.txt /\n");
    await writeFile(join(repo, "api", "requirements.txt"), "flask\n");

    await exec("git", ["-C", repo, "add", "-A", "-f"]);
    await exec("git", ["-C", repo, "commit", "-q", "-m", "init"]);
    return repo;
  }

  it("gives each service its own context and its own .dockerignore", async () => {
    const packed = new Map<string, string[]>();
    const dockerfiles = new Map<string, string>();
    const buildArgs = new Map<string, unknown>();
    const order = ["web", "api"];
    let call = 0;

    const buildImage = vi.fn(async (body: NodeJS.ReadableStream, opts: Record<string, unknown>) => {
      const name = order[call++]!;
      dockerfiles.set(name, String(opts.dockerfile));
      buildArgs.set(name, opts.buildargs);
      const chunks: Buffer[] = [];
      for await (const chunk of body.pipe(createGunzip()))
        chunks.push(Buffer.from(chunk as Buffer));
      packed.set(name, tarEntries(Buffer.concat(chunks)));
      return { on: () => {}, pipe: () => {} } as unknown as NodeJS.ReadableStream;
    });

    const runtime = runtimeFor(
      { kind: "local", description: "local socket" },
      { _docker: { buildImage }, streamDockerodeBuild: vi.fn(async () => {}) },
    );

    const repo = await makeMixedRepo();
    const results = await runtime.buildImages(
      [
        {
          ...spec(
            serviceConfig(repo, {
              sessionId: "sess-web",
              rootDirectory: "",
              buildContextDirectory: "",
              dockerfilePath: undefined,
              buildArgs: { APP_PACKAGE: "@myorg/web" },
            }),
          ),
          serviceName: "web",
        },
        {
          ...spec(
            serviceConfig(repo, {
              sessionId: "sess-api",
              rootDirectory: "api",
              buildContextDirectory: "api",
              dockerfilePath: "Dockerfile",
              buildArgs: { APP_PACKAGE: "@myorg/api" },
            }),
          ),
          serviceName: "api",
        },
      ],
      new BuildLogger(() => {}),
    );

    expect(results.map((r) => r.result.status)).toEqual(["deploying", "deploying"]);

    // The subdir service builds from ITS directory — the root `.dockerignore`'s `api`
    // rule is not its file and must not have deleted the tree it needs.
    expect(dockerfiles.get("api")).toBe("Dockerfile");
    expect(packed.get("api")).toEqual(["Dockerfile", "requirements.txt"]);

    // And the ROOT service still gets the root `.dockerignore` applied — the prune was
    // skipped for the shared tree, so it has to arrive as a pack-time filter instead.
    // Losing this half is the silent hole: secrets and ignored dirs into the image.
    expect(dockerfiles.get("web")).toBe("Dockerfile");
    expect(packed.get("web")).toEqual([".dockerignore", "Dockerfile", "web", "web/index.html"]);
    expect(buildArgs.get("web")).toMatchObject({ APP_PACKAGE: "@myorg/web" });
    expect(buildArgs.get("api")).toMatchObject({ APP_PACKAGE: "@myorg/api" });
  });
});

describe("dockerode docker build — declared build context (#634)", () => {
  async function capturedTar(): Promise<{ options: Record<string, unknown>; tar: string[] }> {
    let options: Record<string, unknown> = {};
    let tar: string[] = [];

    const buildImage = vi.fn(async (body: NodeJS.ReadableStream, opts: Record<string, unknown>) => {
      options = opts;
      // Read the real tar we hand the daemon — the packed bytes ARE the build
      // context, so nothing short of reading them proves which directory shipped.
      const chunks: Buffer[] = [];
      const gunzip = body.pipe(createGunzip());
      for await (const chunk of gunzip) chunks.push(Buffer.from(chunk as Buffer));
      tar = tarEntries(Buffer.concat(chunks));
      return { on: () => {}, pipe: () => {} } as unknown as NodeJS.ReadableStream;
    });

    const runtime = runtimeFor(
      { kind: "local", description: "local socket" },
      {
        _docker: { buildImage },
        streamDockerodeBuild: vi.fn(async () => {}),
      },
    );

    const results = await runtime.buildImages(
      [spec(serviceConfig(await makeRepo()))],
      new BuildLogger(() => {}),
    );
    expect(results[0]!.result.status).toBe("deploying");

    return { options, tar };
  }

  it("packs the service directory as the build context", async () => {
    const { options, tar } = await capturedTar();

    expect(options.dockerfile).toBe("Dockerfile.api");
    // Exactly the service directory — nothing from above it. A context that reached
    // one directory too high is the COPY failure in #634.
    expect(tar).toEqual(["Dockerfile.api", "requirements.txt"]);
  });

  it("leaves the default builder selected for a plain Dockerfile", async () => {
    const { options } = await capturedTar();

    expect(options.version).toBeUndefined();
  });
});

describe.each([
  { mode: "single", transport: "socket" },
  { mode: "single", transport: "tcp" },
  { mode: "single", transport: "ssh" },
  { mode: "batch", transport: "socket" },
  { mode: "batch", transport: "tcp" },
  { mode: "batch", transport: "ssh" },
] as const)("$transport Engine API $mode build results", ({ mode, transport }) => {
  describe.each(["classic", "buildkit"])("%s builder", (builder) => {
    it.each([false, true])(
      "keeps results authoritative and isolated across builds (firstFails=%s)",
      async (firstFails) => {
        const repo = await makeRepo(
          builder === "buildkit" ? "# syntax=docker/dockerfile:1\nFROM scratch\n" : undefined,
        );
        const verifyImageBuilt = vi.fn(async () => {});
        let buildCount = 0;
        const daemonError = "failed to solve: process exited with code 1";
        const buildImage = vi.fn(async (body: Readable, _options: Record<string, unknown>) => {
          await finished(body.resume());
          const output =
            "fixture: Process exited with code 1\n@workspace/web build: Exited with code 0\n";
          const events: object[] = [
            builder === "classic"
              ? { stream: output }
              : {
                  id: "moby.buildkit.trace",
                  aux: statusResponse({ logs: [{ vertex: "sha256:build", msg: output }] }),
                },
          ];
          if (buildCount === 0 && firstFails) events.push({ error: daemonError });
          else events.push({ aux: { ID: "sha256:built-image" } });
          buildCount += 1;
          return Readable.from(events.map((event) => `${JSON.stringify(event)}\n`));
        });
        const runtime = runtimeFor(
          { kind: transport, description: `${transport} Engine API` },
          {
            _docker: {
              buildImage,
              modem: new Dockerode({ socketPath: "/tmp/openship-test-absent.sock" }).modem,
            },
            verifyImageBuilt,
          },
        );
        const configs = ["first", "next"].map((name) =>
          serviceConfig(repo, {
            sessionId: `result-${transport}-${mode}-${builder}-${firstFails}-${name}`,
          }),
        );
        const results = [];
        if (mode === "single") {
          for (const config of configs) results.push(await runtime.build(config));
        } else {
          const batch = await runtime.buildImages(
            configs.map((config, index) => ({ ...spec(config), serviceName: `service-${index}` })),
            new BuildLogger(),
          );
          results.push(...batch.map((entry) => entry.result));
        }

        expect(results.map((result) => result.status)).toEqual([
          firstFails ? "failed" : "deploying",
          "deploying",
        ]);
        if (firstFails) expect(results[0]?.errorMessage).toContain(daemonError);
        expect(buildImage).toHaveBeenCalledTimes(2);
        for (const [, options] of buildImage.mock.calls) {
          expect(options.version).toBe(builder === "buildkit" ? "2" : undefined);
        }
        expect(verifyImageBuilt).toHaveBeenCalledTimes(firstFails ? 1 : 2);
      },
    );
  });
});
