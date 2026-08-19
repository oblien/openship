import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

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
function fakeDaemon(opts: { statusCode?: number; log?: string }) {
  const created: Array<Record<string, unknown>> = [];
  const removed: Array<Record<string, unknown> | undefined> = [];
  const stream = new PassThrough();
  const docker = {
    createContainer: async (args: Record<string, unknown>) => {
      created.push(args);
      return {
        id: "release-container-1",
        start: async () => {},
        logs: async () => {
          setImmediate(() => {
            if (opts.log) stream.write(Buffer.from(opts.log, "utf8"));
            stream.end();
          });
          return stream;
        },
        wait: async () => ({ StatusCode: opts.statusCode ?? 0 }),
        stop: async () => {},
        remove: async (o?: Record<string, unknown>) => {
          removed.push(o);
        },
      };
    },
  };
  return { docker, created, removed };
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
