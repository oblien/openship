import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { BuildLogger, DockerRuntime, LocalExecutor, sq, type BuildConfig } from "@repo/adapters";
import { generateDockerfile } from "../../../../packages/adapters/src/runtime/docker-build-plan";
import { describeDockerE2E, dockerSocketPath, requireDocker } from "../helpers/docker-e2e";
import { protectedBuildKitImage } from "../helpers/buildkit-image";
import { BUILD_METADATA_FIXTURE } from "../helpers/build-metadata-fixture";

const execFileAsync = promisify(execFile);
const resources = { cpuCores: 0.25, memoryMb: 512, diskMb: 8192 };

/** Exercise the production Cloud Docker command against a real daemon. Only the
 * workspace transport is local; BuildKit, its cgroups, image loading and cleanup
 * are real. Provider namespace admission is covered by the engine tests. */
describeDockerE2E("Cloud builds use a bounded, temporary Docker worker", () => {
  let runtime: DockerRuntime;
  let root: string;
  let executor: LocalExecutor;
  let protectedImage: Awaited<ReturnType<typeof protectedBuildKitImage>>;
  const projectId = `cloud-capacity-e2e-${randomUUID()}`;
  const builder = `openship-cache-${createHash("sha256").update(projectId).digest("hex").slice(0, 24)}`;
  const worker = `buildx_buildkit_${builder}0`;
  const sibling = `${projectId}-runtime`;
  const images = new Set<string>();
  const useSudo = process.platform === "linux" && process.getuid?.() !== 0;
  const privileged = (command: string) => useSudo
    ? `sudo -n env ${sq(`DOCKER_HOST=unix://${dockerSocketPath}`)} sh -c ${sq(command)}` : command;
  const docker = (...args: string[]) => useSudo
    ? execFileAsync("sudo", ["-n", "env", `DOCKER_HOST=unix://${dockerSocketPath}`, "docker", ...args], { timeout: 300_000 })
    : execFileAsync("docker", args, { timeout: 300_000 });
  const inspect = async (name: string) => JSON.parse((await docker("inspect", name)).stdout)[0];

  beforeAll(async () => {
    await requireDocker();
    vi.stubEnv("DOCKER_HOST", `unix://${dockerSocketPath}`);
    vi.stubEnv("DOCKER_CONTEXT", undefined);
    // Fail rather than skip: the new driver must actually run in CI/release tests.
    await docker("buildx", "version");
    protectedImage = await protectedBuildKitImage(projectId, docker);
    root = await mkdtemp(join(tmpdir(), "openship-cloud-build-capacity-"));
    executor = new LocalExecutor();
    // Reap the test's local shell as the Cloud executor reaps its remote task.
    const hostExec = executor.exec.bind(executor);
    executor.exec = (command, options) => hostExec(privileged(command), options);
    const streamExec = executor.streamExec.bind(executor);
    executor.streamExec = (command, logger, options) =>
      streamExec(privileged(command), logger, { ...options, killProcessTree: true });
    runtime = await DockerRuntime.create({ transport: "socket", executor });
    Object.assign(runtime, { connectionOptions: { transport: "cloud", executor } });
    // Every case needs the same kernel prerequisite. Fail fixture setup once
    // with the worker's trusted startup logs instead of timing out each build.
    const bootstrap = runtime as unknown as {
      startProtectedBuildWorker(config: BuildConfig, logger: BuildLogger): Promise<void>;
      cleanupProtectedBuildWorker(projectId: string): Promise<void>;
    };
    try {
      await bootstrap.startProtectedBuildWorker({ projectId, resources } as BuildConfig, new BuildLogger());
      expect((await docker("logs", worker)).stderr).toContain("OPENSHIP_BUILD_METADATA_GUARD_READY:1");
    } catch (error) {
      console.error("Protected BuildKit fixture startup:",
        await docker("logs", worker).catch(cause => ({ error: String(cause) })));
      throw error;
    } finally {
      await bootstrap.cleanupProtectedBuildWorker(projectId);
    }
    await docker("run", "-d", "--name", sibling, "alpine:3.20", "sleep", "600");
  });

  afterAll(async () => {
    if (runtime) {
      await docker("buildx", "rm", "--force", builder).catch(() => {});
      await docker("rm", "-f", worker, sibling).catch(() => {});
      // --keep-state is correct in production; only this suite's cache is disposable.
      await docker("volume", "rm", `${worker}_state`).catch(() => {});
      for (const image of images) await docker("rmi", "-f", image).catch(() => {});
      await runtime.dispose();
    }
    if (protectedImage) await protectedImage.dispose();
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function build(outcome: "success" | "failure" | "cancel", limits = resources) {
    const marker = `running-${randomUUID()}`;
    const image = `openship/capacity-e2e:${randomUUID()}`;
    images.add(image);
    await writeFile(
      join(root, "Dockerfile"),
      [
        "FROM alpine:3.20",
        // Keep a real RUN active long enough to inspect the actual worker limits.
        `RUN echo ${marker} && sleep ${outcome === "cancel" ? 60 : 3}${outcome === "failure" ? " && exit 7" : ""}`,
        'CMD ["echo", "cloud-build-capacity-ok"]',
        "",
      ].join("\n"),
    );
    const controller = new AbortController();
    const logs: string[] = [];
    // Calling the existing private command boundary avoids implementing a second
    // build runner in the test or provisioning any paid Cloud infrastructure.
    const remote = runtime as unknown as {
      buildImageOnRemote(
        config: BuildConfig,
        directory: string,
        dockerfile: string,
        tag: string,
        logger: BuildLogger,
        options: { signal: AbortSignal },
      ): Promise<void>;
    };
    const result = remote
      .buildImageOnRemote(
        { projectId, sessionId: marker, resources: limits } as BuildConfig,
        root,
        "Dockerfile",
        image,
        new BuildLogger((entry) => logs.push(entry.message)),
        { signal: controller.signal },
      )
      .then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
    try {
      let completed: Awaited<typeof result> | undefined;
      void result.then(value => { completed = value; });
      const deadline = Date.now() + 120_000;
      while (!logs.join("\n").includes(marker)) {
        if (completed?.error) throw completed.error;
        if (completed || Date.now() >= deadline)
          throw new Error(`Build did not reach its RUN marker.\n${logs.join("\n")}`);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      const active = await inspect(worker);
      expect(active.State.Running).toBe(true);
      // Host GC must leave the attached cache alone while this RUN is active.
      const pruned = await runtime.pruneBuildCache({ all: true, keepStorageBytes: 0 });
      expect(pruned.cachesDeleted).not.toContain(`${worker}_state`);
      expect(active.HostConfig.Memory).toBe(limits.memoryMb * 1024 * 1024);
      expect(active.HostConfig.MemorySwap).toBe(limits.memoryMb * 1024 * 1024);
      expect(active.HostConfig.CpuQuota).toBe(limits.cpuCores * 100_000);
      expect(active.HostConfig.CpuPeriod).toBe(limits.cpuCores ? 100_000 : 0);
      expect((await inspect(sibling)).State.Running).toBe(true);
      if (outcome === "cancel") controller.abort();
      const finished = await result;
      if (outcome === "success") {
        expect(finished.error, logs.join("\n")).toBeNull();
        expect((await docker("run", "--rm", image)).stdout.trim()).toBe("cloud-build-capacity-ok");
      } else if (outcome === "cancel") {
        expect(finished.error).toMatchObject({ name: "BuildCancelledError" });
      } else {
        expect(finished.error).toBeInstanceOf(Error);
        expect(logs.join("\n")).toContain("exit code: 7");
      }
      expect((await docker("ps", "-aq", "--filter", `name=^/${worker}$`)).stdout.trim()).toBe("");
      expect((await inspect(sibling)).State.Running).toBe(true);
    } finally {
      controller.abort();
      await result;
    }
  }

  it.each(["success", "failure", "cancel"] as const)(
    "enforces the selected budget and removes the worker after %s",
    build,
  );
  it.each(["success", "failure", "cancel"] as const)(
    "keeps the real Cloud build worker uncapped and removes it after %s",
    outcome => build(outcome, { cpuCores: 0, memoryMb: 0, diskMb: 0 }),
  );

  /** Only this disposable worker receives the mock link-local addresses. A
   * request is never attempted until their loopback ownership is verified. */
  async function metadataBuild(command: string, options: {
    guard?: boolean; allow?: "network.host" | "security.insecure";
    alias?: boolean; restart?: boolean; image?: string;
  } = {}) {
    const tag = `openship/metadata-e2e:${randomUUID()}`;
    images.add(tag);
    await writeFile(join(root, "Dockerfile"), `FROM ${options.image ?? "busybox:1.37.0"}\nARG OPENSHIP_METADATA_ATTEMPT\nRUN ${command}\n`);
    const logs: string[] = [];
    const original = executor.streamExec.bind(executor);
    executor.streamExec = async (buildCommand, logger, execOptions) => {
      const active = await inspect(worker);
      expect(active.HostConfig.NetworkMode).toBe("bridge");
      expect(active.Config.Entrypoint).toEqual(["/usr/local/bin/openship-buildkitd"]);
      if (options.restart) {
        // A post-bootstrap-only guard would be lost here. The shipped image
        // must reapply it before buildkitd accepts the next request.
        await docker("exec", "--user", "0", active.Id, "sh", "-ec",
          "iptables -w 5 -t raw -F OPENSHIP_METADATA_V1; ip6tables -w 5 -t raw -F OPENSHIP_METADATA_V1");
        await docker("restart", active.Id);
        await vi.waitFor(async () => {
          expect((await docker("exec", active.Id, "buildctl", "debug", "workers")).stdout).toContain("linux");
        }, { timeout: 60_000, interval: 200 });
      }
      await docker("exec", "--user", "0", active.Id, "sh", "-ec", [
        "ip addr add 169.254.169.254/32 dev lo",
        "ip addr add 198.18.0.1/32 dev lo",
        "sysctl -w net.ipv6.conf.all.disable_ipv6=0 >/dev/null",
        "sysctl -w net.ipv6.conf.lo.disable_ipv6=0 >/dev/null",
        "ip -6 addr add fd00:ec2::254/128 dev lo",
        "ip -6 addr add fd20:ce::254/128 dev lo",
        "ip -o addr show dev lo | grep -F '169.254.169.254/32'",
        "ip -o -6 addr show dev lo | grep -F 'fd00:ec2::254/128'",
        "ip -o -6 addr show dev lo | grep -F 'fd20:ce::254/128'",
      ].join("\n"));
      const helper = `${projectId}-metadata-${randomUUID()}`;
      try {
        await docker("run", "-d", "--name", helper, "--network", `container:${active.Id}`,
          "--read-only", "--cap-drop=ALL", "--cap-add=NET_BIND_SERVICE",
          "--entrypoint", "python3", "python:3.14-alpine", "-u", "-c", BUILD_METADATA_FIXTURE);
        await vi.waitFor(async () => {
          expect((await docker("logs", helper)).stdout).toContain("OPENSHIP_METADATA_FIXTURE_READY");
        }, { timeout: 30_000, interval: 100 });
        if (options.guard === false) {
          // Negative control is intentionally unprotected, and can reach only
          // the verified worker-loopback mock. It proves the test is meaningful.
          await docker("exec", "--user", "0", active.Id, "sh", "-ec",
            "iptables -w 5 -t raw -F OPENSHIP_METADATA_V1; ip6tables -w 5 -t raw -F OPENSHIP_METADATA_V1");
        }
        const flags = [options.allow ? `--allow=${options.allow}` : "",
          options.alias ? "--add-host=metadata.test:169.254.169.254" : ""].filter(Boolean).join(" ");
        // Product builds never grant host/insecure entitlements. This test-only
        // client grant exercises the OUTPUT/IPv6 guard too, beyond that default.
        return await original(buildCommand.replace("docker buildx build ", `docker buildx build ${flags} `), logger, execOptions);
      } finally {
        // Release the shared namespace before production worker cleanup.
        await docker("rm", "-f", helper).catch(() => {});
      }
    };
    try {
      const remote = runtime as unknown as {
        buildImageOnRemote(config: BuildConfig, directory: string, dockerfile: string,
          tag: string, logger: BuildLogger): Promise<void>;
      };
      let error: unknown = null;
      try {
        await remote.buildImageOnRemote({ projectId, sessionId: randomUUID(), resources,
          buildArgs: { OPENSHIP_METADATA_ATTEMPT: randomUUID() } } as BuildConfig,
          root, "Dockerfile", tag, new BuildLogger(entry => logs.push(entry.message)));
      } catch (cause) { error = cause; }
      return { error, logs: logs.join("\n") };
    } finally { executor.streamExec = original; }
  }

  it("blocks actual mock metadata over OCI forwarding, DNS aliases, host mode and IPv6", async () => {
    for (const [command, options] of [
      ["wget -T 2 -qO- http://169.254.169.254/latest/meta-data", {}],
      ["wget -T 2 -qO- http://metadata.test/latest/meta-data", { alias: true }],
      ["--network=host wget -T 2 -qO- http://169.254.169.254/latest/meta-data", { allow: "network.host" }],
      ["--network=host wget -T 2 -qO- 'http://[fd00:ec2::254]/latest/meta-data'", { allow: "network.host" }],
      ["--network=host wget -T 2 -qO- 'http://[fd20:ce::254]/computeMetadata/v1'", { allow: "network.host" }],
    ] as const) {
      const control = await metadataBuild(command, { ...options, guard: false });
      expect(control.error, control.logs).toBeNull();
      expect(control.logs).toContain("OPENSHIP_MOCK_METADATA");
      const guarded = await metadataBuild(command, options);
      expect(guarded.error, guarded.logs).toBeInstanceOf(Error);
      expect(guarded.logs).not.toContain("OPENSHIP_MOCK_METADATA");
      expect(guarded.logs).toMatch(/wget:.*(?:timed out|refused|failed)|exit code: 1/);
    }
  });

  it("reapplies the guard after a worker restart before any build executes", async () => {
    const guarded = await metadataBuild("wget -T 2 -qO- http://169.254.169.254/latest/meta-data", { restart: true });
    expect(guarded.error, guarded.logs).toBeInstanceOf(Error);
    expect(guarded.logs).not.toContain("OPENSHIP_MOCK_METADATA");
  });

  it("preserves package-style HTTP and provider DNS while refusing untrusted NET_ADMIN", async () => {
    const result = await metadataBuild("nslookup packages.test 169.254.169.254 && wget -T 5 -qO- http://198.18.0.1/ && if ip link add openship-bypass type dummy 2>/tmp/denied; then exit 91; else grep -i permitted /tmp/denied; fi");
    expect(result.error, result.logs).toBeNull();
    expect(result.logs).toContain("OPENSHIP_PACKAGE_OK");
    expect(result.logs).toContain("198.18.0.1");
    // Bind a distinct loopback client address. A real VM querying a remote
    // resolver also receives replies at its client IP, not at the metadata IP.
    const query = [
      "import socket, struct",
      "client = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)",
      "client.bind(('::1', 0))",
      "assert client.getsockname()[0] == '::1'",
      "client.settimeout(3)",
      "name = b''.join(bytes([len(label)]) + label for label in [b'packages', b'test']) + bytes([0])",
      "packet = struct.pack('!6H', 1234, 256, 1, 0, 0, 0) + name + struct.pack('!2H', 1, 1)",
      "client.sendto(packet, ('fd20:ce::254', 53))",
      "response, peer = client.recvfrom(1024)",
      "assert peer[0] == 'fd20:ce::254' and response[:2] == packet[:2]",
      "assert response[-4:] == socket.inet_aton('198.18.0.1')",
      "print('198.18.0.1')",
    ].join("; ");
    const ipv6 = await metadataBuild(`--network=host python3 -c ${sq(query)}`, {
      allow: "network.host", image: "python:3.14-alpine",
    });
    expect(ipv6.error, ipv6.logs).toBeNull();
    expect(ipv6.logs).toContain("198.18.0.1");
  });

  it("keeps host networking opt-in and refuses insecure execution at the daemon", async () => {
    const host = await metadataBuild("--network=host wget -T 2 -qO- http://169.254.169.254/latest/meta-data");
    expect(host.error, host.logs).toBeInstanceOf(Error);
    expect(host.logs).toMatch(/network.host.*not allowed|not allowed.*network.host/);
    const insecure = await metadataBuild("echo UNTRUSTED_STEP", { allow: "security.insecure" });
    expect(insecure.error, insecure.logs).toBeInstanceOf(Error);
    expect(insecure.logs).toMatch(/security.insecure.*not allowed|not allowed.*security.insecure/);
  });

  it("reuses tool cache after worker recreation and keeps the prior image usable after failure", async () => {
    await writeFile(join(root, "Dockerfile"), [
      "FROM alpine:3.20",
      "ARG BUILD",
      "ARG FAIL=false",
      'RUN --mount=type=cache,id=packages,target=/cache,sharing=locked if [ -f /cache/ready ]; then echo CACHE_REUSED; else echo CACHE_EMPTY; fi && touch /cache/ready && echo "$BUILD" > /version',
      'RUN test "$FAIL" = false',
      'CMD ["cat", "/version"]',
    ].join("\n"));
    const remote = runtime as unknown as {
      buildImageOnRemote(config: BuildConfig, directory: string, dockerfile: string,
        tag: string, logger: BuildLogger): Promise<void>;
    };
    let attemptedTag = "";
    const attempt = async (version: string, fail = false) => {
      const tag = `openship/cache-e2e:${randomUUID()}`;
      attemptedTag = tag;
      images.add(tag);
      const logs: string[] = [];
      await remote.buildImageOnRemote({ projectId, sessionId: randomUUID(), resources,
        buildArgs: { BUILD: version, FAIL: String(fail) } } as BuildConfig, root, "Dockerfile", tag,
        new BuildLogger(entry => logs.push(entry.message)));
      return { tag, logs: logs.join("\n") };
    };
    const first = await attempt("first");
    expect(first.logs).toContain("CACHE_EMPTY");
    const second = await attempt("second");
    expect(second.logs).toContain("CACHE_REUSED");
    expect((await docker("run", "--rm", second.tag)).stdout.trim()).toBe("second");
    await expect(attempt("failed", true)).rejects.toThrow(/exit code: 1/);
    await expect(docker("image", "inspect", attemptedTag)).rejects.toThrow();
    expect((await docker("run", "--rm", first.tag)).stdout.trim()).toBe("first");
    expect((await docker("ps", "-aq", "--filter", `name=^/${worker}$`)).stdout.trim()).toBe("");
    const state = JSON.parse((await docker("volume", "inspect", `${worker}_state`)).stdout)[0];
    expect(state.Labels["openship.build-cache.project"]).toBe(projectId);
    expect(state.Labels["openship.project"]).toBeUndefined();
  });

  it.each([
    { version: "1.22.22", install: "yarn install --pnp", run: "node -r ./.pnp.js" },
    { version: "4.9.2", install: "yarn install", run: "yarn node" },
  ])("keeps Yarn $version PnP dependencies runnable after the build worker stops", async ({ version, install, run }) => {
    const directory = await mkdtemp(join(root, "yarn-pnp-"));
    const tag = `openship/yarn-pnp-e2e:${randomUUID()}`;
    images.add(tag);
    const command = `${run} -p "require('is-number')(42)"`;
    const config = {
      projectId, sessionId: randomUUID(), resources,
      buildImage: "node:22-bookworm-slim", runtimeImage: "node:22-bookworm-slim",
      stack: "node", packageManager: "yarn", buildCache: true,
      installCommand: install, buildCommand: command, startCommand: command,
      rootDirectory: "", envVars: {}, port: 3000,
    } as BuildConfig;
    const logs: string[] = [];
    try {
      await writeFile(join(directory, "package.json"), JSON.stringify({
        name: "openship-pnp-fixture", private: true, packageManager: `yarn@${version}`,
        dependencies: { "is-number": "7.0.0" },
      }));
      await writeFile(join(directory, ".yarnrc.yml"), "nodeLinker: pnp\nenableGlobalCache: true\n");
      await writeFile(join(directory, "Dockerfile"), generateDockerfile(config));
      const remote = runtime as unknown as {
        buildImageOnRemote(config: BuildConfig, directory: string, dockerfile: string,
          tag: string, logger: BuildLogger): Promise<void>;
      };
      await remote.buildImageOnRemote(config, directory, "Dockerfile", tag,
        new BuildLogger(entry => logs.push(entry.message)));
      expect((await docker("ps", "-aq", "--filter", `name=^/${worker}$`)).stdout.trim()).toBe("");
      // A cached build must not need its cache volume or network at runtime.
      const result = await docker("run", "--rm", "--network", "none", tag);
      expect(result.stdout.trim(), logs.join("\n")).toBe("true");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("keeps the non-root SSH Docker client and elevates only cache filesystem I/O", async () => {
    expect(process.getuid?.(), "This fixture must exercise the actual non-root CI login").not.toBe(0);
    const project = `${projectId}-ssh`;
    const sshBuilder = `openship-cache-${createHash("sha256").update(project).digest("hex").slice(0, 24)}`;
    const sshWorker = `buildx_buildkit_${sshBuilder}0`;
    const commands: string[] = [];
    const login = new LocalExecutor();
    const exec = login.exec.bind(login);
    const stream = login.streamExec.bind(login);
    login.exec = (command, options) => { commands.push(command); return exec(command, options); };
    login.streamExec = (command, logger, options) => { commands.push(command); return stream(command, logger, options); };
    const ssh = await DockerRuntime.create({ transport: "socket", executor: login });
    Object.assign(ssh, { connectionOptions: { transport: "ssh", executor: login } });
    const tag = `openship/ssh-cache-e2e:${randomUUID()}`;
    images.add(tag);
    await writeFile(join(root, "Dockerfile"), 'FROM busybox:1.37.0\nRUN echo SSH_NONROOT_BUILD\nCMD ["true"]\n');
    try {
      const remote = ssh as unknown as {
        buildImageOnRemote(config: BuildConfig, directory: string, dockerfile: string,
          tag: string, logger: BuildLogger): Promise<void>;
      };
      await remote.buildImageOnRemote({ projectId: project, sessionId: randomUUID(), resources } as BuildConfig,
        root, "Dockerfile", tag, new BuildLogger());
      expect(commands).toContain("docker info --format '{{.DockerRootDir}}'");
      expect(commands.some(command => command.startsWith("docker buildx create"))).toBe(true);
      expect(commands.some(command => command.startsWith("sudo -n") && command.includes("docker buildx"))).toBe(false);
      expect(commands.some(command => command.startsWith("sudo -n") && command.includes("df -Pk"))).toBe(true);
      expect(commands.some(command => command.startsWith("sudo -n") && command.includes("mkdir -p") && command.includes("/var/lib/openship/build-cache"))).toBe(true);
      await ssh.cleanupProject(project, { wipeVolumes: false });
      expect(commands.some(command => command.startsWith("sudo -n") && command.includes("du -sk"))).toBe(true);
      expect(commands.some(command => command.startsWith("sudo -n") && command.includes("rm -f") && command.includes("/var/lib/openship/build-cache"))).toBe(true);
      await expect(docker("volume", "inspect", `${sshWorker}_state`)).rejects.toThrow();
      await docker("run", "--rm", tag);
    } finally {
      await login.exec(`docker buildx rm --force ${sq(sshBuilder)}`).catch(() => {});
      await docker("rm", "-f", sshWorker).catch(() => {});
      await docker("volume", "rm", `${sshWorker}_state`).catch(() => {});
      await ssh.dispose();
    }
  });

});
