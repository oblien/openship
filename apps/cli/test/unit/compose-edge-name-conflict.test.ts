import { describe, it, expect, vi } from "vitest";

/**
 * The edge is the one compose service pinned to a fixed `container_name`
 * (`openship-edge`) — the api reaches it by that name, and "ours" detection greps
 * it. A fixed name is also a collision: `compose up` only recreates a container it
 * LABELS as its own, so an `openship-edge` left by any other owner aborts the whole
 * stack with "the container name is already in use". `removeOrphanedStack` can't
 * clear it (it matches our exact config_files label), so these pin the extra guard:
 * reclaim the name from anything this project doesn't own, leave our own edge alone.
 */

// compose.ts pulls these in at module load; the predicate under test does no IO.
vi.mock("node:child_process", () => ({
  execFile: (_c: unknown, _a: unknown, cb: (e: null, o: { stdout: string }) => void) =>
    cb(null, { stdout: "" }),
  spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
}));
vi.mock("node:fs", () => ({
  existsSync: () => false,
  mkdirSync: () => undefined,
  readFileSync: () => "",
  writeFileSync: () => undefined,
}));
vi.mock("../../src/lib/source-install", () => ({ readSourceInstall: () => null }));
vi.mock("@repo/adapters/proxy", () => ({ sanitizeEdgeVhosts: async () => {} }));
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

import { edgeNameNeedsReclaim, composePaths } from "../../src/lib/compose";

const OURS = composePaths.file; // the compose file this project labels its containers with
const PROJECT = "openship";
/** name\tproject\tconfig_files, one container per line — the sweep's own format. */
const rows = (...lines: string[]) => lines.join("\n");
const edge = (project: string, configFiles: string) =>
  `openship-edge\t${project}\t${configFiles}`;

describe("edgeNameNeedsReclaim", () => {
  it("leaves our own edge alone (same project + our compose file)", () => {
    expect(edgeNameNeedsReclaim(edge(PROJECT, OURS), PROJECT)).toBe(false);
  });

  it("does nothing when there is no openship-edge at all", () => {
    const out = rows(
      `openship-postgres-1\t${PROJECT}\t${OURS}`,
      `some-other-app\tother\t/srv/other/docker-compose.yml`,
    );
    expect(edgeNameNeedsReclaim(out, PROJECT)).toBe(false);
  });

  it("reclaims a label-less edge from a `docker run` takeover (no compose labels)", () => {
    expect(edgeNameNeedsReclaim(edge("", ""), PROJECT)).toBe(true);
  });

  it("reclaims an edge from a previous project name (even on our compose file)", () => {
    // Different project → not ours. removeOrphanedStack also catches this shape, but
    // the reclaim must agree, or a race where one skips leaves the name held.
    expect(edgeNameNeedsReclaim(edge("openship-old", OURS), PROJECT)).toBe(true);
  });

  it("reclaims a from-source edge (our project name, a DIFFERENT compose file)", () => {
    expect(
      edgeNameNeedsReclaim(edge(PROJECT, "/root/openship/docker/docker-compose.yml"), PROJECT),
    ).toBe(true);
  });

  it("finds our edge among many containers and still leaves it", () => {
    const out = rows(
      `openship-postgres-1\t${PROJECT}\t${OURS}`,
      `openship-redis-1\t${PROJECT}\t${OURS}`,
      edge(PROJECT, OURS),
      `unrelated\tother\t/srv/other/docker-compose.yml`,
    );
    expect(edgeNameNeedsReclaim(out, PROJECT)).toBe(false);
  });

  it("accepts our file among a comma-separated config_files list (base + override)", () => {
    expect(edgeNameNeedsReclaim(edge(PROJECT, `${OURS},${OURS}.override.yml`), PROJECT)).toBe(
      false,
    );
  });
});
