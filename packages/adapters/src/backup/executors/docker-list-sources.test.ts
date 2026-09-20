/**
 * `listSources`' DB fallback double-scoped an already-scoped volume name.
 *
 * The fallback runs whenever the container is gone — a stopped service, one destroyed
 * and not yet redeployed — which is exactly when a backup matters most. It applied the
 * `openship-<slug>-` prefix unconditionally, so a row storing the already-scoped name
 * resolved to `openship-<slug>-openship-<slug>-<name>`. Docker creates that on mount,
 * so the capture archived an empty volume and a restore wrote into one nothing reads.
 *
 * Bind-mount classification must happen through the Docker daemon too. The API can be
 * containerized or connected to a remote Docker host, so its own filesystem says
 * nothing about whether a daemon-side source is a directory, file, FIFO, or socket.
 */

import { describe, expect, it, vi } from "vitest";
import { DockerBackupExecutor } from "./docker";
import type { ServiceHandle } from "../types";

const DIRECTORY_MODE = 2 ** 31 + 0o755;
const FILE_MODE = 0o600;
const FIFO_MODE = 2 ** 25 + 0o600;
const SOCKET_MODE = 2 ** 24 + 0o660;

function archiveInfo(mode: number) {
  return {
    headers: {
      "x-docker-container-path-stat": Buffer.from(
        JSON.stringify({ name: "source", size: 0, mode, mtime: new Date(0).toISOString() }),
      ).toString("base64"),
    },
    resume: vi.fn(),
  };
}

type ProbeCreateSpec = {
  Image?: string;
  NetworkDisabled?: boolean;
  HostConfig?: {
    Mounts?: Array<{
      Type?: string;
      Source?: string;
      Target?: string;
      ReadOnly?: boolean;
    }>;
  };
};

function executorForDeclaredBinds(
  modes: Record<string, number>,
  missing: ReadonlySet<string> = new Set(),
) {
  const removals: Array<ReturnType<typeof vi.fn>> = [];
  const createContainer = vi.fn(async (spec: ProbeCreateSpec) => {
    const mount = spec.HostConfig?.Mounts?.[0];
    const source = mount?.Source ?? "";
    if (missing.has(source)) {
      throw Object.assign(
        new Error(
          `invalid mount config for type "bind": bind source path does not exist: ${source}`,
        ),
        { statusCode: 400 },
      );
    }
    if (!(source in modes)) throw new Error(`unexpected probe for ${source}`);
    const remove = vi.fn(async () => undefined);
    removals.push(remove);
    return {
      infoArchive: vi.fn(async () => archiveInfo(modes[source]!)),
      remove,
    };
  });
  const pullImage = vi.fn(async () => undefined);
  return {
    executor: new DockerBackupExecutor({
      docker: { createContainer },
      pullImage,
    } as never),
    createContainer,
    pullImage,
    removals,
  };
}

const executor = new DockerBackupExecutor({
  docker: {
    getContainer() {
      throw new Error("listSources must not touch the daemon when containerId is null");
    },
  },
} as never);

const handle = (volumes: string[], over: Partial<ServiceHandle> = {}): ServiceHandle =>
  ({
    id: "svc_1",
    projectId: "prj_1",
    projectSlug: "clincai",
    name: "db",
    image: "postgres:16",
    env: {},
    volumes,
    containerId: null,
    namespaceVolumes: true,
    ...over,
  }) as ServiceHandle;

describe("DockerBackupExecutor.listSources", () => {
  it("scopes a bare named volume", async () => {
    const sources = await executor.listSources(handle(["pgdata:/var/lib/postgresql/data"]));
    expect(sources).toEqual([
      {
        id: "openship-clincai-pgdata-0",
        source: "openship-clincai-pgdata",
        target: "/var/lib/postgresql/data",
        type: "volume",
      },
    ]);
  });

  it("does NOT re-scope a name already stored scoped", async () => {
    const sources = await executor.listSources(
      handle(["openship-clincai-pgdata:/var/lib/postgresql/data"]),
    );
    expect(sources.map((s) => s.source)).toEqual(["openship-clincai-pgdata"]);
  });

  it("leaves bind mounts and grandfathered services alone", async () => {
    const fallback = executorForDeclaredBinds({}, new Set(["/srv/data"]));
    const binds = await fallback.executor.listSources(handle(["/srv/data:/data"]));
    expect(binds.map((s) => s.source)).toEqual(["/srv/data"]);

    const bare = await executor.listSources(handle(["pgdata:/data"], { namespaceVolumes: false }));
    expect(bare.map((s) => s.source)).toEqual(["pgdata"]);
  });

  it("keeps another project's prefix distinct rather than adopting it", async () => {
    const sources = await executor.listSources(handle(["openship-other-pgdata:/data"]));
    expect(sources.map((s) => s.source)).toEqual(["openship-clincai-openship-other-pgdata"]);
  });

  it("uses daemon path metadata to exclude remote files and sockets", async () => {
    const modes: Record<string, number> = {
      "/run/secrets/key": FILE_MODE,
      "/run/events": FIFO_MODE,
      "/var/run/docker.sock": SOCKET_MODE,
      "/var/lib/data": DIRECTORY_MODE,
    };
    const infoArchive = vi.fn(async ({ path }: { path: string }) => archiveInfo(modes[path]!));
    const inspectExecutor = new DockerBackupExecutor({
      docker: {
        getContainer() {
          return {
            inspect: async () => ({
              Mounts: [
                {
                  Type: "bind",
                  Source: "/remote-host/run/secrets/key",
                  Destination: "/run/secrets/key",
                },
                {
                  Type: "bind",
                  Source: "/remote-host/var/run/docker.sock",
                  Destination: "/var/run/docker.sock",
                },
                {
                  Type: "bind",
                  Source: "/remote-host/run/events",
                  Destination: "/run/events",
                },
                {
                  Type: "bind",
                  Source: "/remote-host/data",
                  Destination: "/var/lib/data",
                },
                {
                  Type: "volume",
                  Name: "pgdata",
                  Destination: "/var/lib/postgresql/data",
                },
              ],
            }),
            infoArchive,
          };
        },
      },
    } as never);

    const sources = await inspectExecutor.listSources(handle([], { containerId: "cnt_123" }));

    expect(sources).toEqual([
      {
        id: "/remote-host/data",
        source: "/remote-host/data",
        target: "/var/lib/data",
        type: "bind",
      },
      {
        id: "pgdata",
        source: "pgdata",
        target: "/var/lib/postgresql/data",
        type: "volume",
      },
    ]);
    expect(infoArchive.mock.calls.map(([opts]) => opts.path)).toEqual([
      "/run/secrets/key",
      "/var/run/docker.sock",
      "/run/events",
      "/var/lib/data",
    ]);
  });

  it("probes DB fallback binds through the daemon without starting helpers", async () => {
    const fallback = executorForDeclaredBinds({
      "/remote-host/config": FILE_MODE,
      "/remote-host/docker.sock": SOCKET_MODE,
      "/remote-host/events": FIFO_MODE,
      "/remote-host/data": DIRECTORY_MODE,
    });
    const sources = await fallback.executor.listSources(
      handle([
        "/remote-host/config:/etc/config",
        "/remote-host/docker.sock:/var/run/docker.sock",
        "/remote-host/events:/run/events",
        "/remote-host/data:/data",
        "pgdata:/var/lib/postgresql/data",
      ]),
    );

    expect(sources.map((s) => s.source)).toEqual(["/remote-host/data", "openship-clincai-pgdata"]);
    expect(fallback.pullImage).toHaveBeenCalledOnce();
    expect(fallback.createContainer).toHaveBeenCalledTimes(4);
    for (const [spec] of fallback.createContainer.mock.calls) {
      expect(spec).toMatchObject({
        Image: "alpine:3",
        NetworkDisabled: true,
        HostConfig: {
          Mounts: [
            {
              Type: "bind",
              Target: "/__openship_bind_source",
              ReadOnly: true,
            },
          ],
        },
      });
    }
    for (const remove of fallback.removals) expect(remove).toHaveBeenCalledWith({ force: true });
  });

  it("keeps a missing DB bind so a restore can create and populate it", async () => {
    const fallback = executorForDeclaredBinds({}, new Set(["/remote-host/new-data"]));
    const sources = await fallback.executor.listSources(handle(["/remote-host/new-data:/data"]));

    expect(sources.map((s) => s.source)).toEqual(["/remote-host/new-data"]);
  });

  it("does not hide a daemon-side path inspection failure behind the DB fallback", async () => {
    const inspectExecutor = new DockerBackupExecutor({
      docker: {
        getContainer() {
          return {
            inspect: async () => ({
              Mounts: [
                {
                  Type: "bind",
                  Source: "/remote-host/data",
                  Destination: "/data",
                },
              ],
            }),
            infoArchive: async () => {
              throw new Error("daemon archive-info failed");
            },
          };
        },
      },
    } as never);

    await expect(
      inspectExecutor.listSources(handle(["fallback:/data"], { containerId: "cnt_123" })),
    ).rejects.toThrow("daemon archive-info failed");
  });
});
