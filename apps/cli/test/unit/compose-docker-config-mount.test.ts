import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * #581: the API pulls images through dockerode over the mounted daemon socket, and
 * dockerode — unlike the docker CLI — reads no `config.json`. On a compose install the
 * container also cannot see the host's, so a private-image pull went out anonymous even
 * on a `docker login`-ed host.
 *
 * `openship up` therefore mounts an existing host config into the API service only,
 * read-only. What is pinned here is the three ways that goes wrong: mounting a config
 * that does not exist (Docker would create a DIRECTORY at the source and every read
 * inside the container fails EISDIR), mounting it into more than the API, and emitting
 * a path the YAML parser re-reads as something else.
 */

const h = vi.hoisted(() => ({
  /** Paths that "exist" for existsSync. */
  existing: new Set<string>(),
  /** path → { isFile } for statSync; absent throws ENOENT like the real call. */
  stats: new Map<string, { isFile: boolean }>(),
  written: new Map<string, string>(),
}));

vi.mock("node:child_process", () => ({
  execFile: (_c: unknown, _a: unknown, cb: (e: null, o: { stdout: string }) => void) =>
    cb(null, { stdout: "" }),
  spawnSync: (cmd: string, args: string[] = []) => {
    if (cmd === "docker" && args[0] === "volume") return { status: 1, stdout: "", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  },
}));

vi.mock("node:fs", () => ({
  existsSync: (p: string) => h.existing.has(String(p)),
  mkdirSync: () => undefined,
  realpathSync: (p: string) => String(p),
  readFileSync: (p: string) => h.written.get(String(p)) ?? "",
  writeFileSync: (p: string, data: string) => {
    h.written.set(String(p), String(data));
    h.existing.add(String(p));
  },
  renameSync: (from: string, to: string) => {
    h.written.set(String(to), h.written.get(String(from)) ?? "");
    h.existing.add(String(to));
    h.written.delete(String(from));
    h.existing.delete(String(from));
  },
  chmodSync: () => undefined,
  rmSync: () => undefined,
  statSync: (p: string) => {
    const entry = h.stats.get(String(p));
    if (!entry) {
      const err = new Error(`ENOENT: no such file or directory, stat '${p}'`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return { isFile: () => entry.isFile };
  },
}));

vi.mock("../../src/lib/source-install", () => ({ readSourceInstall: () => null }));
vi.mock("@repo/adapters/proxy", () => ({ sanitizeEdgeVhosts: async () => {} }));

vi.mock("@repo/adapters", async () => {
  const lua = await import("../../../../packages/adapters/src/infra/openresty-lua");
  const { dockerSocketMock } = await import("../helpers/harness");
  return {
    ...dockerSocketMock,
    systemCatalog: { installs: { docker: () => ({ supported: false }) } },
    EDGE_HOST_STATE_DIR: lua.EDGE_HOST_STATE_DIR,
    EDGE_CONTAINER_MOUNTS: lua.EDGE_CONTAINER_MOUNTS,
    invalidateEdgeContainer: () => {},
    LocalExecutor: class {},
  };
});

import { composeUp } from "../../src/lib/compose";

/** The generated compose file, whatever path it was written to. */
function composeYaml(): string {
  for (const [path, body] of h.written) {
    if (path.endsWith("docker-compose.yml")) return body;
  }
  throw new Error("no compose file was written");
}

/** The `volumes:` block of one service, so a mount can be attributed to it. */
function volumesOf(service: string): string {
  const yaml = composeYaml();
  const start = yaml.indexOf(`\n  ${service}:`);
  if (start === -1) throw new Error(`service ${service} not found`);
  const next = yaml.slice(start + 1).search(/\n {2}[a-z]/);
  const block = next === -1 ? yaml.slice(start) : yaml.slice(start, start + 1 + next);
  const vol = block.indexOf("volumes:");
  return vol === -1 ? "" : block.slice(vol);
}

const ORIGINAL_DOCKER_CONFIG = process.env.DOCKER_CONFIG;

beforeEach(() => {
  h.existing = new Set(["/var/run/docker.sock"]);
  h.stats = new Map();
  h.written = new Map();
  delete process.env.DOCKER_CONFIG;
});

afterEach(() => {
  if (ORIGINAL_DOCKER_CONFIG === undefined) delete process.env.DOCKER_CONFIG;
  else process.env.DOCKER_CONFIG = ORIGINAL_DOCKER_CONFIG;
});

describe("openship up — host Docker config mount (#581)", () => {
  it("omits the mount entirely when the host has no Docker config", async () => {
    await composeUp({ version: "0.3.0" });
    expect(composeYaml()).not.toContain(".docker/config.json");
    // The marker must never survive into the written file.
    expect(composeYaml()).not.toContain("__OPENSHIP_DOCKER_CONFIG_MOUNT__");
  });

  it("mounts an existing config read-only into the api service", async () => {
    process.env.DOCKER_CONFIG = "/home/op/.docker";
    h.stats.set("/home/op/.docker/config.json", { isFile: true });

    await composeUp({ version: "0.3.0" });
    const api = volumesOf("api");
    expect(api).toContain("type: bind");
    expect(api).toContain('source: "/home/op/.docker/config.json"');
    expect(api).toContain("target: /root/.docker/config.json");
    expect(api).toContain("read_only: true");
  });

  it("mounts it into NO other service", async () => {
    process.env.DOCKER_CONFIG = "/home/op/.docker";
    h.stats.set("/home/op/.docker/config.json", { isFile: true });

    await composeUp({ version: "0.3.0" });
    // Credentials belong to the component that pulls. One occurrence, in `api`.
    expect(composeYaml().split("/root/.docker/config.json")).toHaveLength(2);
    expect(volumesOf("edge")).not.toContain(".docker/config.json");
    expect(volumesOf("dashboard")).not.toContain(".docker/config.json");
  });

  it("does NOT mount a config path that is a directory", async () => {
    // Docker bind-mounts a missing/odd source by creating a directory at it, which
    // leaves the container's config.json a directory — every read then fails EISDIR
    // instead of degrading to "no credentials configured".
    process.env.DOCKER_CONFIG = "/home/op/.docker";
    h.stats.set("/home/op/.docker/config.json", { isFile: false });

    await composeUp({ version: "0.3.0" });
    expect(composeYaml()).not.toContain(".docker/config.json");
  });

  it("quotes a path containing YAML-significant characters", async () => {
    // The short `source:target:ro` form would split this path on its own colon and
    // mount something else entirely.
    process.env.DOCKER_CONFIG = "/home/my op:1/.docker";
    h.stats.set("/home/my op:1/.docker/config.json", { isFile: true });

    await composeUp({ version: "0.3.0" });
    expect(volumesOf("api")).toContain('source: "/home/my op:1/.docker/config.json"');
  });

  it("resolves a relative DOCKER_CONFIG to an absolute source", async () => {
    // A bind source must be absolute; compose resolves a relative one against the
    // file's directory, which is not where the operator's shell was.
    process.env.DOCKER_CONFIG = "rel/.docker";
    const abs = `${process.cwd()}/rel/.docker/config.json`;
    h.stats.set(abs, { isFile: true });

    await composeUp({ version: "0.3.0" });
    expect(volumesOf("api")).toContain(`source: ${JSON.stringify(abs)}`);
  });
});
