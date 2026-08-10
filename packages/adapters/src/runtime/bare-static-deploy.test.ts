import { describe, expect, it, vi } from "vitest";
import { BareRuntime } from "./bare";
import type { CommandExecutor } from "../types";

/**
 * `deployStatic` is the LAST gate before a static site goes live, and until now it
 * only asserted the doc-root directory exists. That passes for a directory the
 * build left empty — so the deploy went green and every request 404'd, with
 * nothing in the logs pointing at the output directory.
 *
 * An EMPTY root is safe to hard-fail: no path under it can serve anything, so
 * unlike a missing index.html (legitimate when the site is routed only at a
 * subpath) the verdict needs no knowledge of the routes.
 */

/** Minimal executor: `exists` from a path set, `exec` from a shell-command stub. */
function makeExecutor(opts: {
  paths?: string[];
  exec?: (command: string) => string | Promise<string>;
}): CommandExecutor {
  const paths = new Set(opts.paths ?? []);
  return {
    exec: vi.fn(async (command: string) => (opts.exec ? await opts.exec(command) : "")),
    streamExec: vi.fn(async () => ({ code: 0, output: "" })),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ""),
    exists: vi.fn(async (p: string) => paths.has(p)),
    mkdir: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
    transferIn: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as CommandExecutor;
}

const ROOT = "/opt/openship/static/proj_1";

/** `imageRef` is omitted so workDir === stagedDir and no artifact promotion runs. */
function config(outputDirectory: string) {
  return {
    projectId: "proj_1",
    deploymentId: "dep_1",
    outputDirectory,
  } as unknown as Parameters<BareRuntime["deployStatic"]>[0];
}

describe("BareRuntime.deployStatic doc-root assertions", () => {
  it("fails when the doc-root is missing", async () => {
    const rt = new BareRuntime({ workDir: "/opt/openship/static", executor: makeExecutor({}) });
    await expect(rt.deployStatic(config("dist"))).rejects.toThrow(/output directory/i);
  });

  it("fails when the doc-root exists but is EMPTY", async () => {
    const rt = new BareRuntime({
      workDir: "/opt/openship/static",
      executor: makeExecutor({
        paths: [`${ROOT}/dist`],
        // `[ -d ]` true, `ls -A` prints nothing → DIR alone == empty.
        exec: () => "DIR\n",
      }),
    });
    await expect(rt.deployStatic(config("dist"))).rejects.toThrow(/is empty/i);
  });

  it("succeeds when the doc-root has content", async () => {
    const rt = new BareRuntime({
      workDir: "/opt/openship/static",
      executor: makeExecutor({
        paths: [`${ROOT}/dist`],
        exec: () => "DIR\nindex.html\n",
      }),
    });
    const res = await rt.deployStatic(config("dist"));
    expect(res.status).toBe("running");
    expect(res.containerId).toBe(ROOT);
  });

  it("does not report a plain FILE doc-root as empty — a file is its own index", async () => {
    const rt = new BareRuntime({
      workDir: "/opt/openship/static",
      executor: makeExecutor({
        paths: [`${ROOT}/index.html`],
        // Not a directory → the `if [ -d ]` branch prints nothing at all.
        exec: () => "",
      }),
    });
    await expect(rt.deployStatic(config("index.html"))).resolves.toMatchObject({
      status: "running",
    });
  });

  it("treats an unreadable probe as inconclusive and DEPLOYS", async () => {
    // A probe that can't read must never be the thing that fails a deploy — the
    // root existed, which is the contract this method actually enforces.
    const rt = new BareRuntime({
      workDir: "/opt/openship/static",
      executor: makeExecutor({
        paths: [`${ROOT}/dist`],
        exec: () => Promise.reject(new Error("permission denied")),
      }),
    });
    await expect(rt.deployStatic(config("dist"))).resolves.toMatchObject({ status: "running" });
  });
});
