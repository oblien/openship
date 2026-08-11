import { describe, it, expect } from "vitest";
import {
  DEFAULT_DOCKER_SOCKET_PATH,
  resolveDockerTransport,
  resolveLocalDockerSocketPath,
} from "./docker-transport";

describe("resolveLocalDockerSocketPath", () => {
  it("prefers an explicit dockerSocketPath over everything", () => {
    expect(
      resolveLocalDockerSocketPath({ dockerSocketPath: "/tmp/explicit.sock" }, {
        DOCKER_HOST: "unix:///tmp/from-env.sock",
      }),
    ).toBe("/tmp/explicit.sock");
  });

  it("honors a unix:// DOCKER_HOST (Colima / Rancher / Podman / rootless)", () => {
    expect(
      resolveLocalDockerSocketPath(undefined, {
        DOCKER_HOST: "unix:///Users/me/.colima/default/docker.sock",
      }),
    ).toBe("/Users/me/.colima/default/docker.sock");
  });

  it("honors a bare absolute path in DOCKER_HOST", () => {
    expect(resolveLocalDockerSocketPath(undefined, { DOCKER_HOST: "/run/user/1000/docker.sock" })).toBe(
      "/run/user/1000/docker.sock",
    );
  });

  it("ignores a DOCKER_HOST the socket transport cannot dial", () => {
    // tcp:// needs mutual TLS material and is handled by the tcp transport.
    expect(resolveLocalDockerSocketPath(undefined, { DOCKER_HOST: "tcp://10.0.0.1:2376" })).toBe(
      DEFAULT_DOCKER_SOCKET_PATH,
    );
    expect(resolveLocalDockerSocketPath(undefined, { DOCKER_HOST: "ssh://root@host" })).toBe(
      DEFAULT_DOCKER_SOCKET_PATH,
    );
    // unix:// with a relative remainder is not a socket path either.
    expect(resolveLocalDockerSocketPath(undefined, { DOCKER_HOST: "unix://relative/docker.sock" })).toBe(
      DEFAULT_DOCKER_SOCKET_PATH,
    );
  });

  it("falls back to the default when nothing is set (and ignores blanks)", () => {
    expect(resolveLocalDockerSocketPath(undefined, {})).toBe(DEFAULT_DOCKER_SOCKET_PATH);
    expect(resolveLocalDockerSocketPath({ dockerSocketPath: "  " }, { DOCKER_HOST: "  " })).toBe(
      DEFAULT_DOCKER_SOCKET_PATH,
    );
  });
});

describe("resolveDockerTransport (socket branch)", () => {
  it("dials the resolved path and names it in the diagnostics", async () => {
    const transport = resolveDockerTransport({
      transport: "socket",
      dockerSocketPath: "/tmp/colima.sock",
    });
    expect(transport.kind).toBe("socket");
    expect(await transport.establish()).toEqual({ socketPath: "/tmp/colima.sock" });
    expect(transport.description).toContain("/tmp/colima.sock");
    expect(transport.unreachableHint).toContain("/tmp/colima.sock");
  });

  it("still defaults with no options at all", async () => {
    const prev = process.env.DOCKER_HOST;
    delete process.env.DOCKER_HOST;
    try {
      expect(await resolveDockerTransport().establish()).toEqual({
        socketPath: DEFAULT_DOCKER_SOCKET_PATH,
      });
    } finally {
      if (prev !== undefined) process.env.DOCKER_HOST = prev;
    }
  });
});
