import { describe, expect, it } from "vitest";
import { resolveCloudWorkloadCmd } from "../src/runtime/cloud/compose";

/**
 * #332 (cloud runtime): the compose `commandArgv` must run as the workload Cmd
 * verbatim — cwd comes from `working_dir`, so NO `sh -c`/`cd` wrap (that broke
 * entrypoint+CMD images). Legacy string / built-app start commands keep the wrap.
 */
describe("resolveCloudWorkloadCmd (#332)", () => {
  const workdir = "/app";

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
});
