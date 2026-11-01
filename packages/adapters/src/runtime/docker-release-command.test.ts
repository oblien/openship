import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { DockerRuntime } from "./docker";
import type { DeployConfig } from "../types";

/**
 * The docker release phase runs each command in a THROWAWAY container off the
 * freshly-built image, before anything is activated.
 *
 * Why a one-off container and not an exec into the deployment: at this point the
 * new version isn't running and the OLD one still is — an exec would run the new
 * release's migrations inside the old image, and a failure would take a healthy
 * container down with it. The call shape below is what encodes that: no
 * published port (it must never contend with the running app for the loopback
 * pin), no restart policy (a command that exits non-zero must fail, not bounce),
 * and the container is removed either way.
 */
function frame(text: string, type = 1): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function fakeDaemon(opts: { statusCode?: number; log?: string; chunks?: Buffer[] } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const removed: Array<Record<string, unknown> | undefined> = [];
  const stream = new PassThrough();
  const container = {
    id: "release-container-1",
    start: vi.fn(async (_args?: unknown) => {}),
    logs: vi.fn(async (_args?: unknown) => {
      setImmediate(() => {
        for (const chunk of opts.chunks ?? [frame(opts.log ?? "")]) stream.write(chunk);
        stream.end();
      });
      return stream;
    }),
    wait: vi.fn(async (_args?: unknown) => ({ StatusCode: opts.statusCode ?? 0 })),
    remove: vi.fn(async (o?: Record<string, unknown>) => { removed.push(o); }),
  };
  const docker = {
    getImage: () => ({ inspect: async () => ({ Config: {} }) }),
    createContainer: vi.fn(async (args: Record<string, unknown>) => {
      created.push(args);
      return container;
    }),
    getContainer: vi.fn((_id: string) => container),
    listNetworks: vi.fn(async () => []),
    createNetwork: vi.fn(async () => ({ id: "project-network" })),
  };
  return { docker, container, stream, created, removed };
}

function config(overrides: Partial<DeployConfig> = {}): DeployConfig {
  return {
    projectId: "proj_1",
    deploymentId: "dep_1",
    buildSessionId: "bs_1",
    imageRef: "openship/proj_1:dep_1",
    environment: "production",
    port: 3000,
    hostPort: 41234,
    envVars: { DATABASE_URL: "postgres://u:p@db/app" },
    resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
    restartPolicy: "always",
    slug: "my-app",
    volumes: ["storage:/app/storage"],
    ...overrides,
  } as unknown as DeployConfig;
}

async function runtimeWith(docker: unknown): Promise<DockerRuntime> {
  const runtime = await DockerRuntime.create({
    dockerSocketPath: "/tmp/openship-test-absent.sock",
  });
  (runtime as unknown as { _docker: unknown })._docker = docker;
  return runtime;
}

describe("DockerRuntime.runReleaseCommand", () => {
  // The release container gets the app's env by construction (deploymentContainerEnv),
  // so it inherits deploy's rules rather than a copy of them. A project-set PATH
  // replaces the image's own (the one our Dockerfile bakes node_modules/.bin into),
  // which is the openship#623 failure: a release command exiting 127 on a
  // completely green build.
  it("drops a project-set PATH, exactly as deploy does, and says so", async () => {
    const { docker, created } = fakeDaemon({});
    const lines: Array<{ message: string; level?: string }> = [];
    await (await runtimeWith(docker)).runReleaseCommand(
      config({ envVars: { DATABASE_URL: "postgres://u:p@db/app", PATH: "/copied/from/heroku" } }),
      "npx prisma migrate deploy",
      (entry) => lines.push(entry),
    );
    const env = created[0]!.Env as string[];
    expect(env.some((entry) => entry.startsWith("PATH="))).toBe(false);
    expect(env).toContain("DATABASE_URL=postgres://u:p@db/app");
    expect(lines.some((line) => line.level === "warn" && line.message.includes("PATH"))).toBe(true);
  });

  // A worker deploy listens on nothing, so deploy withholds PORT (#538-B). The
  // release container must match, or a migration sees a PORT the app never does.
  it("omits PORT for a portless (worker) deploy, exactly as deploy does", async () => {
    const { docker, created } = fakeDaemon({});
    await (await runtimeWith(docker)).runReleaseCommand(
      config({ portless: true } as Partial<DeployConfig>),
      "php artisan migrate --force",
      () => {},
    );
    const env = created[0]!.Env as string[];
    expect(env.some((entry) => entry.startsWith("PORT="))).toBe(false);
    expect(env).toContain("NODE_ENV=production");
  });

  it("declares the capability", async () => {
    const runtime = await runtimeWith(fakeDaemon({}).docker);
    expect(runtime.supports("releaseCommand")).toBe(true);
  });

  it("runs the command in a one-off container off the new image, with the deploy's env and volumes", async () => {
    const { docker, created, removed } = fakeDaemon({ log: "Migrating...\n" });
    const lines: string[] = [];
    await (await runtimeWith(docker)).runReleaseCommand(
      config(),
      "php artisan migrate --force",
      (entry) => lines.push(entry.message),
    );

    expect(created).toHaveLength(1);
    const args = created[0]!;
    expect(args.Image).toBe("openship/proj_1:dep_1");
    expect(args.Labels).toMatchObject({ "openship.project": "proj_1", "openship.build": "bs_1" });
    expect(args.Labels).not.toHaveProperty("openship.deployment");
    // Entrypoint override: a base image's docker-entrypoint.sh would swallow Cmd.
    expect(args.Entrypoint).toEqual(["/bin/sh", "-c"]);
    expect(args.Cmd).toEqual(["php artisan migrate --force"]);
    expect(args.Env).toContain("DATABASE_URL=postgres://u:p@db/app");
    expect(args.Env).toContain("NODE_ENV=production");
    // Same mounts the app gets, project-scoped — a migration has to write to the
    // volume the app will read from.
    const hostConfig = args.HostConfig as Record<string, unknown>;
    expect(hostConfig.Binds).toEqual(["openship-my-app-storage:/app/storage"]);
    // The two things it must NOT inherit from the deploy.
    expect(hostConfig.PortBindings).toBeUndefined();
    expect(hostConfig.RestartPolicy).toBeUndefined();
    // Output reaches the deploy log, and the container doesn't leak.
    expect(lines.join("")).toContain("Migrating...");
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ force: true, v: true });
  });

  it("fails the deploy on a non-zero exit, with the command's output in the message", async () => {
    const { docker, removed } = fakeDaemon({
      statusCode: 1,
      log: "SQLSTATE[42S02]: Base table or view not found",
    });
    await expect(
      (await runtimeWith(docker)).runReleaseCommand(config(), "php artisan migrate --force", () => {}),
    ).rejects.toThrow(/exit code 1[\s\S]*SQLSTATE\[42S02\]/);
    // Removed on the failure path too — a failed release must not leave a container.
    expect(removed).toHaveLength(1);
  });

  it("attaches connected-service networks before the command starts", async () => {
    const { docker, container, created } = fakeDaemon();
    const beforeStart = vi.fn(async (id: string) => {
      expect(id).toBe(container.id);
      expect(container.start).not.toHaveBeenCalled();
    });
    await (await runtimeWith(docker)).runReleaseCommand(
      config({ networkAlias: "app" }), "migrate", () => {}, { beforeStart },
    );
    expect(beforeStart).toHaveBeenCalledOnce();
    expect(created[0]!.HostConfig).toMatchObject({
      NetworkMode: "project-network", LogConfig: { Type: "json-file" },
    });
  });

  it("does not start the command when network attachment fails", async () => {
    const { docker, container } = fakeDaemon();
    await expect((await runtimeWith(docker)).runReleaseCommand(config(), "migrate", () => {}, {
      beforeStart: async () => { throw new Error("Database network is unavailable"); },
    })).rejects.toThrow("Database network is unavailable");
    expect(container.start).not.toHaveBeenCalled();
    expect(container.remove).toHaveBeenCalledOnce();
  });

  it("requires the app's network instead of silently running on the default bridge", async () => {
    const { docker } = fakeDaemon();
    docker.listNetworks.mockRejectedValueOnce(new Error("Cannot reach Docker"));
    await expect((await runtimeWith(docker)).runReleaseCommand(
      config({ networkAlias: "app" }), "migrate", () => {},
    )).rejects.toThrow("Cannot reach Docker");
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it.each(["start", "logs", "wait"] as const)("bounds a stalled %s request and cleans up", async method => {
    const { docker, container } = fakeDaemon();
    container[method].mockImplementationOnce(() => new Promise<never>(() => {}));
    await expect((await runtimeWith(docker)).runReleaseCommand(
      config(), "migrate", () => {}, { timeoutMs: 20 },
    )).rejects.toThrow(/timed out/);
    expect(container.remove).toHaveBeenCalledOnce();
    const call = container[method].mock.calls[0]![0] as { abortSignal: AbortSignal };
    expect(call.abortSignal.aborted).toBe(true);
  });

  it("cancels while running without waiting for Docker's wait response", async () => {
    const { docker, container } = fakeDaemon();
    const abort = new AbortController();
    container.wait.mockImplementationOnce(async () => {
      abort.abort(new Error("Cancelled by user"));
      return new Promise<never>(() => {});
    });
    await expect((await runtimeWith(docker)).runReleaseCommand(
      config(), "migrate", () => {}, { signal: abort.signal },
    )).rejects.toThrow("Cancelled by user");
    expect(container.remove).toHaveBeenCalledOnce();
  });

  it("cleans up by name after a lost create response, and reaps a late response too", async () => {
    const { docker, container } = fakeDaemon();
    let finish!: (candidate: typeof container) => void;
    docker.createContainer.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await expect((await runtimeWith(docker)).runReleaseCommand(
      config(), "migrate", () => {}, { timeoutMs: 20 },
    )).rejects.toThrow(/timed out/);
    expect(docker.getContainer).toHaveBeenCalledWith(expect.stringContaining("openship-release-dep_1-"));
    finish(container);
    await vi.waitFor(() => expect(container.remove).toHaveBeenCalledTimes(2));
    expect(container.start).not.toHaveBeenCalled();
  });

  it("decodes fragmented and coalesced Docker frames without losing UTF-8 output", async () => {
    const wire = Buffer.concat([frame("Migrating λ…\n"), frame("warning\n", 2), frame("Done\n")]);
    const chunks = Array.from(wire, (_byte, index) => wire.subarray(index, index + 1));
    const { docker } = fakeDaemon({ chunks });
    const lines: Array<{ message: string; level?: string }> = [];
    await (await runtimeWith(docker)).runReleaseCommand(config(), "migrate", entry => lines.push(entry));
    expect(lines.map(line => line.message).join("")).toBe("Migrating λ…\nwarning\nDone\n");
    expect(lines.find(line => line.message === "warning\n")?.level).toBe("warn");
  });

  it("fails and removes the candidate if the log transport fails", async () => {
    const { docker, stream, container } = fakeDaemon();
    container.logs.mockImplementationOnce(async () => {
      setImmediate(() => stream.destroy(new Error("SSH disconnected")));
      return stream;
    });
    container.wait.mockImplementationOnce(() => new Promise<never>(() => {}));
    await expect((await runtimeWith(docker)).runReleaseCommand(config(), "migrate", () => {}))
      .rejects.toThrow("SSH disconnected");
    expect(container.remove).toHaveBeenCalledOnce();
  });

  it("does not treat truncated output as a successful command", async () => {
    const { docker, container } = fakeDaemon({ chunks: [frame("migrated").subarray(0, 10)] });
    await expect((await runtimeWith(docker)).runReleaseCommand(config(), "migrate", () => {}))
      .rejects.toThrow(/mid-frame/);
    expect(container.remove).toHaveBeenCalledOnce();
  });

  it("refuses without a built image rather than running against nothing", async () => {
    const { docker } = fakeDaemon({});
    await expect(
      (await runtimeWith(docker)).runReleaseCommand(
        config({ imageRef: undefined }),
        "php artisan migrate --force",
        () => {},
      ),
    ).rejects.toThrow(/imageRef/);
  });
});
