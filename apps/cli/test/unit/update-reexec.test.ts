import { describe, it, expect } from "vitest";

/**
 * `openship update` fetches the new bundle, then re-execs the freshly-fetched
 * binary to run the reconcile (`update --apply-only`) so the NEW compose template
 * / service unit lands in the same command. These pin the two subtle bits of that
 * re-exec: the argv ordering (`--json` is a ROOT option, so it must precede the
 * subcommand) and the loop guard (a re-exec'd child must never re-exec again).
 */

import { applyOnlyArgv, isReexecChild, REEXEC_ENV } from "../../src/lib/update-reexec";

describe("applyOnlyArgv", () => {
  it("appends the subcommand after the CLI's own entry args", () => {
    expect(applyOnlyArgv(["/opt/cli/dist/index.js"], false)).toEqual([
      "/opt/cli/dist/index.js",
      "update",
      "--apply-only",
    ]);
  });

  it("works for a launcher invocation with no entry args (tarball)", () => {
    expect(applyOnlyArgv([], false)).toEqual(["update", "--apply-only"]);
  });

  it("puts --json BEFORE the subcommand (root option, not `update --json`)", () => {
    const argv = applyOnlyArgv(["/opt/cli/dist/index.js"], true);
    expect(argv).toEqual([
      "/opt/cli/dist/index.js",
      "--json",
      "update",
      "--apply-only",
    ]);
    // The contract: --json must precede `update`, or the subcommand parser rejects it.
    expect(argv.indexOf("--json")).toBeLessThan(argv.indexOf("update"));
  });
});

describe("isReexecChild", () => {
  it("is true only when the sentinel env is exactly '1'", () => {
    expect(isReexecChild({ [REEXEC_ENV]: "1" })).toBe(true);
  });

  it("is false when the sentinel is unset or any other value", () => {
    expect(isReexecChild({})).toBe(false);
    expect(isReexecChild({ [REEXEC_ENV]: "0" })).toBe(false);
    expect(isReexecChild({ [REEXEC_ENV]: "true" })).toBe(false);
  });
});
