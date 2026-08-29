import { describe, expect, it } from "vitest";
import { nodeBinPathExport } from "@repo/core";
import { resolveCloudWorkloadCmd } from "../src/runtime/cloud/compose";

/**
 * #332 (cloud runtime): the compose `commandArgv` must run as the workload Cmd
 * verbatim — cwd comes from `working_dir`, so NO `sh -c`/`cd` wrap (that broke
 * entrypoint+CMD images). Legacy string / built-app start commands keep the wrap.
 *
 * openship#623 adds `binPathExport`: the string branch runs through a bare
 * `sh -c`, which does NOT prepend `node_modules/.bin` the way `npm run` does, so
 * a dependency-binary start command (`next start`) exited 127. The prelude is
 * confined to that branch — see the argv cases below.
 */
describe("resolveCloudWorkloadCmd (#332)", () => {
  const workdir = "/app";
  /** Exactly what cloud.ts:1805 passes: roots [workDir, "/app"] for a node PM. */
  const prelude = nodeBinPathExport("npm", [workdir, "/app"]);

  it("compose argv runs verbatim — no sh -c, no cd", () => {
    expect(resolveCloudWorkloadCmd({ commandArgv: ["serve", "--host", "0.0.0.0"], workdir }))
      .toEqual(["serve", "--host", "0.0.0.0"]);
  });

  it("argv wins over a legacy start command", () => {
    expect(resolveCloudWorkloadCmd({ commandArgv: ["node", "x"], startCommand: "ignored", workdir }))
      .toEqual(["node", "x"]);
  });

  it("empty argv ([] = clear CMD) → undefined (image default process)", () => {
    expect(resolveCloudWorkloadCmd({ commandArgv: [], workdir })).toBeUndefined();
  });

  it("legacy string / built start command keeps the cd + sh -c wrap (workdir shell-quoted)", () => {
    expect(resolveCloudWorkloadCmd({ startCommand: "node server.js", workdir }))
      .toEqual(["sh", "-c", "cd '/app' && node server.js"]);
  });

  it("no argv and no start command → undefined (image default)", () => {
    expect(resolveCloudWorkloadCmd({ workdir })).toBeUndefined();
    expect(resolveCloudWorkloadCmd({ commandArgv: null, workdir })).toBeUndefined();
  });

  // ── openship#623: the node_modules/.bin prelude ──────────────────────────

  // Pinned as a literal so a change to the prelude's SHAPE (quoting, separator,
  // the trailing "$PATH" that keeps the image PATH reachable) is visible here
  // and not silently absorbed by building both sides from the same helper.
  it("the prelude keeps the inherited PATH and dedups a root-level app", () => {
    expect(prelude).toBe(`export PATH='/app/node_modules/.bin':"$PATH"`);
    expect(nodeBinPathExport("npm", ["/app/production", "/app"]))
      .toBe(`export PATH='/app/production/node_modules/.bin':'/app/node_modules/.bin':"$PATH"`);
  });

  it("a string start command gets the prelude ahead of the cd (#623 — `next start` was exit 127)", () => {
    expect(resolveCloudWorkloadCmd({ startCommand: "next start", workdir, binPathExport: prelude }))
      .toEqual(["sh", "-c", `export PATH='/app/node_modules/.bin':"$PATH" && cd '/app' && next start`]);
  });

  it("a string start command WITHOUT a prelude is byte-identical to before (#332 lock)", () => {
    const expected = ["sh", "-c", "cd '/app' && next start"];
    // Absent (every caller that has not been threaded yet)...
    expect(resolveCloudWorkloadCmd({ startCommand: "next start", workdir })).toEqual(expected);
    // ...and the empty string a non-node package manager produces: Go/Rust/Python
    // have no node_modules/.bin, so nothing must be chained on.
    expect(nodeBinPathExport("go", [workdir])).toBe("");
    expect(resolveCloudWorkloadCmd({ startCommand: "next start", workdir, binPathExport: "" }))
      .toEqual(expected);
  });

  // The load-bearing negative. A compose service runs its OWN image's argv, and
  // that image owns its PATH — injecting ours would both re-introduce the `sh -c`
  // wrap #332 removed and point the container at a node_modules that isn't there.
  it("argv is returned verbatim even when a prelude is supplied — no PATH, no sh -c", () => {
    const argv = ["node", "dist/server.js"];
    const cmd = resolveCloudWorkloadCmd({
      commandArgv: argv,
      startCommand: "next start",
      workdir,
      binPathExport: prelude,
    });
    expect(cmd).toEqual(argv);
    expect(cmd!.join(" ")).not.toContain("PATH");
    expect(cmd!.join(" ")).not.toContain("node_modules/.bin");
    expect(cmd![0]).not.toBe("sh");
  });

  it("empty argv + a prelude is still undefined (the prelude never resurrects a cleared CMD)", () => {
    expect(resolveCloudWorkloadCmd({ commandArgv: [], workdir, binPathExport: prelude }))
      .toBeUndefined();
    expect(resolveCloudWorkloadCmd({ commandArgv: [], startCommand: "next start", workdir, binPathExport: prelude }))
      .toBeUndefined();
  });

  // cloud.ts used to hand-roll `cd ${workDir} && …` with workDir UNQUOTED; the
  // prelude must not have moved the quoting the shared builder does.
  it("still shell-quotes the workdir when the prelude is present", () => {
    const dir = "/srv/apps/it's here";
    expect(resolveCloudWorkloadCmd({ startCommand: "next start", workdir: dir, binPathExport: prelude }))
      .toEqual([
        "sh",
        "-c",
        `export PATH='/app/node_modules/.bin':"$PATH" && cd '/srv/apps/it'\\''s here' && next start`,
      ]);
  });
});
