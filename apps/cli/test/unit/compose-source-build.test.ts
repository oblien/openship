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

// Keep the heavy adapters barrel out of this unit test.
vi.mock("@repo/adapters", () => ({ systemCatalog: { installs: { docker: () => ({ supported: false }) } } }));

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
  it("builds api/dashboard/edge from the checkout and never pulls them", () => {
    h.sourceInstall = { repo: "oblien/openship", ref: "main", dir: REPO };
    for (const f of DOCKERFILES) h.existing.add(f);

    const res = composeUp({ version: "0.3.0" });
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

  it("falls back to pulling when there is no source install", () => {
    const res = composeUp({ version: "0.3.0" });
    expect(res.ok).toBe(true);
    expect(verbs()).toEqual([["pull"], ["up", "-d"]]);
    expect(sourceBuildDir()).toBeNull();
  });

  it("falls back to pulling when the checkout has no Dockerfiles (stale marker)", () => {
    h.sourceInstall = { repo: "oblien/openship", ref: "main", dir: "/gone" };
    const res = composeUp({ version: "0.3.0" });
    expect(res.ok).toBe(true);
    expect(verbs()).toEqual([["pull"], ["up", "-d"]]);
  });

  it("build:false forces the pull path even on a source install", () => {
    h.sourceInstall = { repo: "oblien/openship", ref: "main", dir: REPO };
    for (const f of DOCKERFILES) h.existing.add(f);

    composeUp({ version: "0.3.0", build: false });
    expect(verbs()).toEqual([["pull"], ["up", "-d"]]);
  });
});
