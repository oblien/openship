import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * OPENSHIP_PGDATA detection: an existing Postgres data volume may hold the
 * cluster at the volume root (legacy installs) or in the `pgdata/` subdirectory
 * (fresh installs since the EPERM fix). resolvePgData must pick the path that
 * actually contains the cluster, or fail loudly when it cannot tell.
 */

const h = vi.hoisted(() => ({
  existing: new Set<string>(),
  written: new Map<string, string>(),
  composeCalls: [] as string[][],
  /** Mock state for the postgres data volume. */
  volumeState: "missing" as string,
}));

vi.mock("node:child_process", () => ({
  execFile: (_c: unknown, _a: unknown, cb: (e: null, o: { stdout: string }) => void) =>
    cb(null, { stdout: "" }),
  spawnSync: (cmd: string, args: string[] = []) => {
    if (cmd === "docker" && args[0] === "compose") h.composeCalls.push(args);
    // Volume existence probe used by dbVolumeExists.
    if (cmd === "docker" && args[0] === "volume") {
      if (h.volumeState === "missing") return { status: 1, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    }
    // Volume contents probe used by pgDataLocation (PG_VERSION in / or /pgdata).
    if (cmd === "docker" && args[0] === "run") {
      const loc = h.volumeState === "missing" ? "empty" : h.volumeState;
      if (loc === "empty") return { status: 0, stdout: "empty\n", stderr: "" };
      if (loc === "root") return { status: 0, stdout: "root\n", stderr: "" };
      if (loc === "subdir") return { status: 0, stdout: "subdir\n", stderr: "" };
      return { status: 0, stdout: "unknown\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  },
}));

vi.mock("node:fs", () => ({
  existsSync: (p: string) => h.existing.has(String(p)),
  mkdirSync: () => undefined,
  readFileSync: (p: string) => {
    const v = h.written.get(String(p));
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  },
  writeFileSync: (p: string, data: string) => {
    h.written.set(String(p), String(data));
    h.existing.add(String(p));
  },
}));

vi.mock("../../src/lib/source-install", () => ({
  readSourceInstall: () => null,
}));

vi.mock("@repo/adapters/proxy", () => ({
  sanitizeEdgeVhosts: async () => {},
}));

vi.mock("@repo/adapters", async () => {
  const lua = await import("../../../../packages/adapters/src/infra/openresty-lua");
  return {
    systemCatalog: { installs: { docker: () => ({ supported: false }) } },
    EDGE_HOST_STATE_DIR: lua.EDGE_HOST_STATE_DIR,
    EDGE_CONTAINER_MOUNTS: lua.EDGE_CONTAINER_MOUNTS,
    invalidateEdgeContainer: () => {},
    LocalExecutor: class {},
  };
});

import { composeUp, composePaths } from "../../src/lib/compose";

/** The `.env` this run wrote, parsed back into key → value. */
function writtenEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (h.written.get(composePaths.env) ?? "").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

beforeEach(() => {
  h.existing = new Set();
  h.written = new Map();
  h.composeCalls = [];
  h.volumeState = "missing";
});

describe("resolvePgData — OPENSHIP_PGDATA path detection", () => {
  it("uses the pgdata/ subdir on a fresh install", async () => {
    const res = await composeUp({});
    expect(res.ok).toBe(true);
    expect(writtenEnv().OPENSHIP_PGDATA).toBe("/var/lib/postgresql/data/pgdata");
  });

  it("keeps the pgdata/ subdir when an existing volume already holds the cluster there", async () => {
    h.volumeState = "subdir";
    const res = await composeUp({});
    expect(res.ok).toBe(true);
    expect(writtenEnv().OPENSHIP_PGDATA).toBe("/var/lib/postgresql/data/pgdata");
  });

  it("keeps the volume root when an existing legacy cluster lives there", async () => {
    h.volumeState = "root";
    const res = await composeUp({});
    expect(res.ok).toBe(true);
    expect(writtenEnv().OPENSHIP_PGDATA).toBe("/var/lib/postgresql/data");
  });

  it("fails loudly when the existing volume is non-empty but has no recognizable PG_VERSION", async () => {
    h.volumeState = "unknown";
    await expect(composeUp({})).rejects.toThrow(/cannot be determined/);
  });
});
