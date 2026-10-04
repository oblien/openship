import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

// Build the production image and render the shipped Compose files. A synthetic
// container with hand-written restrictions would miss merge and startup failures.
describeDockerE2E("remote-only self-hosted control plane", () => {
  const name = `openship-ro-test-${crypto.randomUUID().slice(0, 8)}`;
  const image = `${name}:test`;
  let directory: string;
  let composeArgs: string[];
  let apiId: string;
  let remoteId: string | undefined;
  const remoteImage = `${name}-remote:test`;

  async function docker(args: string[], timeout = 120_000, input?: string): Promise<string> {
    const command = run("docker", args, {
      cwd: repo,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (input !== undefined) command.child.stdin!.end(input);
    const { stdout } = await command;
    if (command.child.killed) throw new Error(`Docker command timed out after ${timeout}ms`);
    return stdout.trim();
  }
  const compose = (args: string[], timeout?: number) => docker([...composeArgs, ...args], timeout);
  async function inApi(script: string, input?: string) {
    // Providers may log diagnostics to stdout. Frame the probe result separately.
    const marker = "OPENSHIP_REMOTE_ONLY_RESULT=";
    const output = await docker(
      [
        "exec",
        ...(input === undefined ? [] : ["-i"]),
        apiId,
        "bun",
        "-e",
        `const report = value => console.log(${JSON.stringify(marker)} + JSON.stringify(value));\n${script}`,
      ],
      120_000,
      input,
    );
    const result = output.split("\n").find((line) => line.startsWith(marker));
    if (!result) throw new Error(`API probe did not report a result:\n${output}`);
    return JSON.parse(result.slice(marker.length));
  }

  beforeAll(async () => {
    await requireDocker();
    directory = await mkdtemp(join(tmpdir(), "openship-remote-only-"));
    await mkdir(join(directory, "docker"));
    for (const file of ["docker-compose.yml", "docker-compose.remote.yml"]) {
      await copyFile(join(repo, "docker", file), join(directory, "docker", file));
    }
    await copyFile(join(repo, "docker-compose.yml"), join(directory, "docker-compose.yml"));
    // Inherited host settings are intentional: environment:null does NOT clear
    // env_file values on Compose, so an overlay must explicitly clear them.
    await writeFile(
      join(directory, ".env"),
      [
        `POSTGRES_PASSWORD=${crypto.randomUUID()}`,
        `BETTER_AUTH_SECRET=${crypto.randomUUID()}${crypto.randomUUID()}`,
        `INTERNAL_TOKEN=${crypto.randomUUID()}${crypto.randomUUID()}`,
        "OPENSHIP_AUTH_MODE=local",
        "OPENSHIP_REQUIRE_REDIS=true",
        "OPENSHIP_HOST_CONTROL=true",
        "OPENSHIP_MANAGED_EDGE=true",
        "OPENSHIP_HOST_SSH_HOST=host.docker.internal",
        "OPENSHIP_HOST_SSH_KEY=/run/secrets/openship_host_key",
      ].join("\n"),
      { mode: 0o600 },
    );
    composeArgs = [
      "compose",
      "--project-name",
      name,
      "--env-file",
      join(directory, ".env"),
      "-f",
      join(directory, "docker/docker-compose.yml"),
      "-f",
      join(directory, "docker/docker-compose.remote.yml"),
    ];

    const config = JSON.parse(await compose(["config", "--format", "json"]));
    expect(Object.keys(config.services).sort()).toEqual(["api", "dashboard", "postgres", "redis"]);
    expect(config.services.api.volumes ?? []).toEqual([]);
    expect(config.services.api.extra_hosts ?? []).toEqual([]);
    expect(config.services.api.environment).toMatchObject({
      CLOUD_MODE: "false",
      OPENSHIP_REMOTE_ONLY: "true",
      OPENSHIP_REQUIRE_AUTH: "true",
      OPENSHIP_HOST_CONTROL: "false",
      OPENSHIP_MANAGED_EDGE: "false",
      OPENSHIP_EDGE_MODE: "none",
      OPENSHIP_HOST_SSH_HOST: "",
      OPENSHIP_HOST_SSH_KEY: "",
    });
    expect(
      config.services.api.ports.every((port: { host_ip: string }) => port.host_ip === "127.0.0.1"),
    ).toBe(true);

    // The original self-hosted stack still owns its local edge and socket; the
    // SaaS stack still has neither. Never apply this overlay to the SaaS file.
    const standard = JSON.parse(
      await docker([...composeArgs.slice(0, -2), "config", "--format", "json"]),
    );
    expect(standard.services.edge.network_mode).toBe("host");
    expect(
      standard.services.api.volumes.some(
        (volume: { target: string }) => volume.target === "/var/run/docker.sock",
      ),
    ).toBe(true);
    const saas = JSON.parse(
      await docker([
        "compose",
        "--env-file",
        join(directory, ".env"),
        "-f",
        join(directory, "docker-compose.yml"),
        "config",
        "--format",
        "json",
      ]),
    );
    expect(saas.services.edge).toBeUndefined();
    expect(saas.services.api.volumes ?? []).toEqual([]);

    console.log("[remote-only-e2e] Building the production API image");
    await docker(["build", "--tag", image, "--file", "apps/api/Dockerfile", "."], 600_000);
    // Only replace the image and port publication for the isolated fixture.
    // All security settings still come from the shipped overlay.
    const override = join(directory, "test.yml");
    await writeFile(
      override,
      `services:\n  api:\n    image: ${image}\n    pull_policy: never\n    ports: !reset []\n`,
    );
    composeArgs.push("-f", override);
    await compose(["up", "-d", "--wait", "--wait-timeout", "120", "api"], 180_000);
    apiId = await compose(["ps", "--quiet", "api"]);
    expect(apiId).toBeTruthy();
  }, 900_000);

  afterAll(async () => {
    if (remoteId) await docker(["rm", "--force", "--volumes", remoteId]);
    await docker(["image", "rm", remoteImage]).catch(() => {});
    if (composeArgs) {
      if (apiId) {
        const state = JSON.parse(await docker(["inspect", apiId]));
        if (state[0].State.Health?.Status !== "healthy")
          console.error(await compose(["logs", "--no-color", "--tail", "100", "api"]));
      } else {
        console.error(
          await compose(["logs", "--no-color", "--tail", "100", "api"]).catch(() => ""),
        );
      }
      await compose(["down", "--volumes", "--timeout", "10"]);
    }
    await docker(["image", "rm", image]).catch(() => {});
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 120_000);

  it("runs without host mounts, capabilities, host namespaces, or Docker socket access", async () => {
    const [container] = JSON.parse(await docker(["inspect", apiId]));
    expect(container.Mounts).toEqual([]);
    expect(container.HostConfig.Privileged).toBe(false);
    expect(container.HostConfig.NetworkMode).not.toBe("host");
    expect(container.HostConfig.PidMode).not.toBe("host");
    expect(container.HostConfig.IpcMode).not.toBe("host");
    expect(container.HostConfig.ExtraHosts ?? []).toEqual([]);
    expect(container.HostConfig.CapDrop).toContain("ALL");
    expect(container.HostConfig.SecurityOpt).toContain("no-new-privileges:true");
    const probe = await inApi(`
      import { existsSync, readFileSync } from "node:fs";
      import { connect } from "node:net";
      const socketError = await new Promise(resolve => {
        const socket = connect("/var/run/docker.sock");
        socket.once("error", error => resolve(error.code));
        socket.once("connect", () => { socket.destroy(); resolve(null); });
      });
      report({
        socketError, keyExists: existsSync("/run/secrets/openship_host_key"),
        status: readFileSync("/proc/self/status", "utf8"),
      });
    `);
    expect(probe.socketError).toBe("ENOENT");
    expect(probe.keyExists).toBe(false);
    expect(probe.status).toMatch(/^CapEff:\s+0+$/m);
    expect(probe.status).toMatch(/^CapBnd:\s+0+$/m);
    expect(probe.status).toMatch(/^NoNewPrivs:\s+1$/m);
  });

  it("bootstraps a real admin, requires login, and refuses a host-control enable without changing other settings", async () => {
    const result = await inApi(`
      const base = "http://127.0.0.1:" + process.env.PORT;
      const origin = "http://localhost:3001";
      let cookie = "";
      const request = async (path, method = "GET", body, extra = {}) => {
        const response = await fetch(base + path, { method, headers: {
          origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extra,
        }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { response, status: response.status, data: await response.json() };
      };
      const anonymous = await request("/api/system/settings");
      const admin = { name: "Remote Operator", email: "operator@example.test", password: "isolation-test-only-password" };
      const bootstrap = await request("/api/system/bootstrap-admin", "POST", admin, { "X-Internal-Token": process.env.INTERNAL_TOKEN });
      const login = await request("/api/auth/sign-in/email", "POST", admin);
      cookie = login.response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
      const settings = await request("/api/system/settings");
      const enable = await request("/api/system/settings", "PATCH", { hostControl: true, productMode: "mail" });
      const after = await request("/api/system/settings");
      const servers = await request("/api/system/servers");
      report({ anonymous: anonymous.status, bootstrap: bootstrap.status, login: login.status,
        settings: { status: settings.status, data: settings.data },
        enable: { status: enable.status, data: enable.data }, after: after.data, servers: servers.data });
    `);
    expect(result.anonymous).toBe(401);
    expect(result.bootstrap).toBe(200);
    expect(result.login).toBe(200);
    expect(result.settings.status).toBe(200);
    expect(result.settings.data).toMatchObject({ hostControlEffective: false });
    expect(result.enable.status).toBe(400);
    expect(result.enable.data.error).toMatch(/remote servers only/);
    expect(result.after).toMatchObject({
      hostControlEffective: false,
      productMode: result.settings.data.productMode,
    });
    expect(result.servers).toEqual([]);
  });

  it("deploys and restarts a workload on a real remote Docker daemon over SSH from the restricted API container", async () => {
    // Reuse the migration suite's isolated SSH + Docker target. Its nested
    // daemon has no host socket or host bind mounts and owns only test workloads.
    const identity = join(directory, "identity");
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity]);
    await docker(
      ["build", "--tag", remoteImage, join(repo, "apps/api/test/fixtures/migration-target")],
      180_000,
    );
    remoteId = await docker([
      "create",
      "--name",
      `${name}-remote`,
      "--privileged",
      "--cgroupns=private",
      "--network",
      `${name}_default`,
      remoteImage,
    ]);
    await docker(["cp", `${identity}.pub`, `${remoteId}:/root/.ssh/authorized_keys`]);
    await docker(["start", remoteId]);
    await expect
      .poll(() => docker(["exec", remoteId!, "cat", "/var/run/sshd.pid"]).catch(() => ""), {
        timeout: 60_000,
        interval: 500,
      })
      .not.toBe("");

    const result = await inApi(
      `
      import { DockerRuntime, createExecutor } from "@repo/adapters";
      const ssh = { host: ${JSON.stringify(`${name}-remote`)}, username: "root", privateKey: await Bun.stdin.text() };
      // Remote servers share a pooled SSH executor with the Docker transport.
      const sshExecutor = createExecutor(ssh);
      const runtime = await DockerRuntime.create({ ...ssh, transport: "ssh", executor: sshExecutor });
      let id, result;
      try {
        await runtime.pullImage("busybox:1.37");
        const deployment = await runtime.deploy({
          deploymentId: "dep_remote_probe", projectId: "proj_remote_probe", buildSessionId: "bld_remote_probe",
          imageRef: "busybox:1.37", environment: "production", slug: "remote-probe", port: 0, portless: true,
          startCommand: "sleep 300", envVars: { REMOTE_PROBE: "reached-remote-daemon" },
          resources: { cpuCores: 0.25, memoryMb: 64 },
        });
        id = deployment.containerId;
        await runtime.stop(id);
        await runtime.start(id);
        const info = await runtime.getContainerInfo(id);
        const executor = await runtime.inContainerExecutor(id);
        const marker = (await executor.exec("printenv REMOTE_PROBE", { timeout: 5_000 })).trim();
        result = { status: info.status, marker, transport: runtime.transport.kind };
      } finally {
        try {
          if (id) await runtime.destroy(id);
        } finally {
          await runtime.dispose();
          await sshExecutor.dispose();
        }
      }
      report(result);
    `,
      await readFile(identity, "utf8"),
    );
    expect(result).toEqual({
      status: "running",
      marker: "reached-remote-daemon",
      transport: "ssh",
    });
  });
});
