import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDockerContextCache,
  DEFAULT_DOCKER_SOCKET_PATH,
  resolveDockerTransport,
  resolveLocalDockerSocketPath,
} from "./docker-transport";

/**
 * A throwaway `DOCKER_CONFIG` dir. Every case sets one, including the cases that
 * assert the default: the CLI-context tier reads the real `~/.docker` otherwise,
 * so an unset config dir would make these tests pass or fail depending on
 * whether the developer runs Colima.
 */
function dockerConfigDir(
  contexts: Record<string, string> = {},
  currentContext?: string,
): string {
  const dir = mkdtempSync(join(tmpdir(), "openship-docker-cfg-"));
  if (currentContext !== undefined) {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ currentContext }));
  }
  for (const [name, host] of Object.entries(contexts)) {
    const digest = createHash("sha256").update(name).digest("hex");
    const metaDir = join(dir, "contexts", "meta", digest);
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(
      join(metaDir, "meta.json"),
      JSON.stringify({ Name: name, Endpoints: { docker: { Host: host } } }),
    );
  }
  return dir;
}

beforeEach(() => clearDockerContextCache());

describe("resolveLocalDockerSocketPath", () => {
  it("prefers an explicit dockerSocketPath over everything", () => {
    expect(
      resolveLocalDockerSocketPath(
        { dockerSocketPath: "/tmp/explicit.sock" },
        {
          DOCKER_HOST: "unix:///tmp/from-env.sock",
          DOCKER_CONFIG: dockerConfigDir({ colima: "unix:///tmp/ctx.sock" }, "colima"),
        },
      ),
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
    const DOCKER_CONFIG = dockerConfigDir();
    // tcp:// needs mutual TLS material and is handled by the tcp transport.
    expect(resolveLocalDockerSocketPath(undefined, { DOCKER_HOST: "tcp://10.0.0.1:2376", DOCKER_CONFIG })).toBe(
      DEFAULT_DOCKER_SOCKET_PATH,
    );
    expect(resolveLocalDockerSocketPath(undefined, { DOCKER_HOST: "ssh://root@host", DOCKER_CONFIG })).toBe(
      DEFAULT_DOCKER_SOCKET_PATH,
    );
    // unix:// with a relative remainder is not a socket path either.
    expect(
      resolveLocalDockerSocketPath(undefined, { DOCKER_HOST: "unix://relative/docker.sock", DOCKER_CONFIG }),
    ).toBe(DEFAULT_DOCKER_SOCKET_PATH);
  });

  it("falls back to the default when nothing is set (and ignores blanks)", () => {
    const DOCKER_CONFIG = dockerConfigDir();
    expect(resolveLocalDockerSocketPath(undefined, { DOCKER_CONFIG })).toBe(DEFAULT_DOCKER_SOCKET_PATH);
    expect(
      resolveLocalDockerSocketPath({ dockerSocketPath: "  " }, { DOCKER_HOST: "  ", DOCKER_CONFIG }),
    ).toBe(DEFAULT_DOCKER_SOCKET_PATH);
  });
});

describe("resolveLocalDockerSocketPath: docker CLI context", () => {
  it("reads the active context when DOCKER_HOST is unset", () => {
    // `colima start` selects a context and exports nothing. Before this tier,
    // `docker ps` worked in the operator's shell while Openship saw no daemon.
    const DOCKER_CONFIG = dockerConfigDir(
      { colima: "unix:///Users/me/.colima/default/docker.sock" },
      "colima",
    );
    expect(resolveLocalDockerSocketPath(undefined, { DOCKER_CONFIG })).toBe(
      "/Users/me/.colima/default/docker.sock",
    );
  });

  it("lets DOCKER_HOST win over the active context", () => {
    const DOCKER_CONFIG = dockerConfigDir({ colima: "unix:///tmp/colima.sock" }, "colima");
    expect(
      resolveLocalDockerSocketPath(undefined, { DOCKER_HOST: "unix:///tmp/explicit.sock", DOCKER_CONFIG }),
    ).toBe("/tmp/explicit.sock");
  });

  it("honors DOCKER_CONTEXT over config.json's currentContext", () => {
    const DOCKER_CONFIG = dockerConfigDir(
      { colima: "unix:///tmp/colima.sock", rancher: "unix:///tmp/rancher.sock" },
      "colima",
    );
    expect(resolveLocalDockerSocketPath(undefined, { DOCKER_CONTEXT: "rancher", DOCKER_CONFIG })).toBe(
      "/tmp/rancher.sock",
    );
  });

  it("treats the `default` context as no context", () => {
    // `default` isn't stored on disk — it means DOCKER_HOST or the default path.
    const DOCKER_CONFIG = dockerConfigDir({ colima: "unix:///tmp/colima.sock" }, "default");
    expect(resolveLocalDockerSocketPath(undefined, { DOCKER_CONFIG })).toBe(DEFAULT_DOCKER_SOCKET_PATH);
  });

  it("ignores a context this transport cannot dial", () => {
    const DOCKER_CONFIG = dockerConfigDir({ remote: "ssh://root@box" }, "remote");
    expect(resolveLocalDockerSocketPath(undefined, { DOCKER_CONFIG })).toBe(DEFAULT_DOCKER_SOCKET_PATH);
  });

  it("survives a missing config, a missing context and unreadable JSON", () => {
    expect(
      resolveLocalDockerSocketPath(undefined, { DOCKER_CONFIG: join(tmpdir(), "openship-no-such-dir") }),
    ).toBe(DEFAULT_DOCKER_SOCKET_PATH);
    // currentContext names a context with no meta.json on disk.
    expect(resolveLocalDockerSocketPath(undefined, { DOCKER_CONFIG: dockerConfigDir({}, "ghost") })).toBe(
      DEFAULT_DOCKER_SOCKET_PATH,
    );
    const broken = dockerConfigDir();
    writeFileSync(join(broken, "config.json"), "{not json");
    expect(resolveLocalDockerSocketPath(undefined, { DOCKER_CONFIG: broken })).toBe(
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
    const prevHost = process.env.DOCKER_HOST;
    const prevConfig = process.env.DOCKER_CONFIG;
    delete process.env.DOCKER_HOST;
    process.env.DOCKER_CONFIG = dockerConfigDir();
    try {
      expect(await resolveDockerTransport().establish()).toEqual({
        socketPath: DEFAULT_DOCKER_SOCKET_PATH,
      });
    } finally {
      if (prevHost !== undefined) process.env.DOCKER_HOST = prevHost;
      if (prevConfig !== undefined) process.env.DOCKER_CONFIG = prevConfig;
      else delete process.env.DOCKER_CONFIG;
    }
  });
});
