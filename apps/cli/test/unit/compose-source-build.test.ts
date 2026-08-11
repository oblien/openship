import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * A from-source ("dev") install must BUILD the images we own from its checkout,
 * never pull them: it tracks a branch, so `__CLI_VERSION__` names an unreleased
 * tag and `docker compose pull` dies with `denied` from the registry — which is
 * exactly how a dev `openship` run got as far as stopping the host's nginx and
 * then failed with the stack down.
 */

const h = vi.hoisted(() => ({
  sourceInstall: null as { repo: string; ref: string; dir: string } | null,
  /** Paths that "exist" — the Dockerfile probe + compose file checks. */
  existing: new Set<string>(),
  written: new Map<string, string>(),
  composeCalls: [] as string[][],
}));

vi.mock("node:child_process", () => ({
  // LocalExecutor (pulled in by compose.ts for the vhost sanitize) uses execFile.
  execFile: (_c: unknown, _a: unknown, cb: (e: null, o: { stdout: string }) => void) =>
    cb(null, { stdout: "" }),
  spawnSync: (cmd: string, args: string[] = []) => {
    if (cmd === "docker" && args[0] === "compose") h.composeCalls.push(args);
    // Fresh install: no pre-existing postgres volume, so the password-reconcile
    // path (which would add its own `up -d --wait postgres`) stays out of the
    // pull/build sequence these tests pin.
    if (cmd === "docker" && args[0] === "volume") return { status: 1, stdout: "", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  },
}));

vi.mock("node:fs", () => ({
  existsSync: (p: string) => h.existing.has(String(p)),
  mkdirSync: () => undefined,
  readFileSync: (p: string) => h.written.get(String(p)) ?? "",
  writeFileSync: (p: string, data: string) => {
    h.written.set(String(p), String(data));
    h.existing.add(String(p));
  },
}));

vi.mock("../../src/lib/source-install", () => ({
  readSourceInstall: () => h.sourceInstall,
}));

// Keep the heavy adapters barrel out of this unit test — but reach through to the
// REAL mount list, because one of the tests below asserts the compose YAML is
// generated from it. Faking that array would make the assertion vacuous.
vi.mock("@repo/adapters/proxy", () => ({
  // compose.ts sanitizes the mounted vhost dir before `up`; no-op under test.
  sanitizeEdgeVhosts: async () => {},
}));

vi.mock("@repo/adapters", async () => {
  const lua = await import("../../../../packages/adapters/src/infra/openresty-lua");
  return {
    systemCatalog: { installs: { docker: () => ({ supported: false }) } },
    // compose.ts imports these for the edge's host state mounts — a partial
    // mock makes the import undefined and vitest fails the whole file.
    EDGE_HOST_STATE_DIR: lua.EDGE_HOST_STATE_DIR,
    EDGE_CONTAINER_MOUNTS: lua.EDGE_CONTAINER_MOUNTS,
    invalidateEdgeContainer: () => {},
    LocalExecutor: class {},
  };
});

import { EDGE_CONTAINER_MOUNTS } from "../../../../packages/adapters/src/infra/openresty-lua";
import { composeUp, sourceBuildDir } from "../../src/lib/compose";

const REPO = "/root/.openship-dev/cli-src";
const DOCKERFILES = [
  `${REPO}/apps/api/Dockerfile`,
  `${REPO}/apps/dashboard/Dockerfile`,
  `${REPO}/apps/edge/Dockerfile`,
];

/** The compose invocations with `compose` and the `-f <file>` pairs stripped, so
 *  what's left is the verb plus its own flags (`up -d`, `pull postgres redis`). */
const verbs = () =>
  h.composeCalls.map((args) => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "compose") continue;
      if (args[i] === "-f") {
        i++; // skip the file path too
        continue;
      }
      out.push(args[i]);
    }
    return out;
  });

beforeEach(() => {
  h.sourceInstall = null;
  h.existing = new Set();
  h.written = new Map();
  h.composeCalls = [];
});

describe("composeUp — from-source install", () => {
  it("builds api/dashboard/edge from the checkout and never pulls them", async () => {
    h.sourceInstall = { repo: "oblien/openship", ref: "main", dir: REPO };
    for (const f of DOCKERFILES) h.existing.add(f);

    const res = await composeUp({ version: "0.3.0" });
    expect(res.ok).toBe(true);

    // Upstream images are still pulled — but ONLY those two, by name.
    expect(verbs()[0]).toEqual(["pull", "postgres", "redis"]);
    expect(verbs()).toContainEqual(["build"]);
    expect(verbs()).toContainEqual(["up", "-d"]);
    // A bare `pull` (which is what hit `denied`) must never run.
    expect(verbs()).not.toContainEqual(["pull"]);

    // Every compose call layers the build override on top of the base file.
    for (const call of h.composeCalls) {
      expect(call.filter((a) => a.endsWith("docker-compose.build.yml"))).toHaveLength(1);
    }

    const override = [...h.written.entries()].find(([p]) => p.endsWith("docker-compose.build.yml"))?.[1];
    expect(override).toContain(`context: ${REPO}`);
    expect(override).toContain("dockerfile: apps/api/Dockerfile");
    expect(override).toContain("dockerfile: apps/dashboard/Dockerfile");
    expect(override).toContain("dockerfile: apps/edge/Dockerfile");
  });

  it("falls back to pulling when there is no source install", async () => {
    const res = await composeUp({ version: "0.3.0" });
    expect(res.ok).toBe(true);
    expect(verbs()).toEqual([["pull"], ["up", "-d"]]);
    expect(sourceBuildDir()).toBeNull();
  });

  it("falls back to pulling when the checkout has no Dockerfiles (stale marker)", async () => {
    h.sourceInstall = { repo: "oblien/openship", ref: "main", dir: "/gone" };
    const res = await composeUp({ version: "0.3.0" });
    expect(res.ok).toBe(true);
    expect(verbs()).toEqual([["pull"], ["up", "-d"]]);
  });

  it("build:false forces the pull path even on a source install", async () => {
    h.sourceInstall = { repo: "oblien/openship", ref: "main", dir: REPO };
    for (const f of DOCKERFILES) h.existing.add(f);

    await composeUp({ version: "0.3.0", build: false });
    expect(verbs()).toEqual([["pull"], ["up", "-d"]]);
  });
});

/**
 * The api and the edge must mount the SAME host paths — the api writes vhosts,
 * certs and static doc-roots, the edge serves them. That list used to be typed out
 * by hand here (twice) next to a third copy in `buildEdgeRunCommand`, so a mount
 * added for `docker run` installs silently never reached compose ones.
 */
describe("composeUp — edge bind mounts", () => {
  const composeYaml = () =>
    [...h.written.entries()].find(([p]) => p.endsWith("docker-compose.yml"))?.[1] ?? "";

  it("gives BOTH api and edge every mount in EDGE_CONTAINER_MOUNTS", async () => {
    await composeUp({ version: "0.3.0" });
    const yaml = composeYaml();

    expect(EDGE_CONTAINER_MOUNTS.length).toBeGreaterThan(0);
    for (const m of EDGE_CONTAINER_MOUNTS) {
      const line = `- ${m.host}:${m.container}:z`;
      expect(yaml.split(line).length - 1).toBe(2); // api + edge
    }
  });

  it("indents them as list items under each service's `volumes:`", async () => {
    // Generated lines are spliced into a template literal, so a wrong indent is the
    // one way this breaks — and it breaks as an unparseable compose file.
    await composeUp({ version: "0.3.0" });
    const lines = composeYaml().split("\n");

    for (const m of EDGE_CONTAINER_MOUNTS) {
      for (const i of lines.flatMap((l, idx) => (l.includes(`${m.host}:${m.container}:z`) ? [idx] : []))) {
        expect(lines[i]).toBe(`      - ${m.host}:${m.container}:z`);
      }
    }
    // Nothing landed at top level, which is what a missing indent would look like.
    expect(lines.some((l) => /^- \//.test(l))).toBe(false);
  });

  it("no longer hardcodes a container path the mount list owns", async () => {
    await composeUp({ version: "0.3.0" });
    const sites = EDGE_CONTAINER_MOUNTS.find((m) => m.container.includes("sites-enabled"));
    expect(sites).toBeDefined();
    // Present via the generated line only — twice, not four times (which is what a
    // leftover hand-written copy alongside the generated one would produce).
    expect(composeYaml().split(sites!.container).length - 1).toBe(2);
  });
});
