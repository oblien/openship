import { describe, expect, it } from "vitest";

import {
  RUNTIME_ENV_EXCLUDES,
  droppedRuntimeEnvMessage,
  splitRuntimeEnv,
} from "../src/runtime/runtime-env";

/**
 * The shared exclude list behind openship#623.
 *
 * This helper exists because the original bug WAS one fix landing on some
 * surfaces and not others, so the four runtimes (docker single-app, docker
 * compose, bare supervisor, cloud workload) all route through it. That makes its
 * contract load-bearing in a way the per-surface tests can't cover: the exact key
 * set, exact-match (not substring) semantics, case sensitivity, and — because
 * docker resolves a repeated key last-one-wins and every caller PREPENDS its own
 * PORT/NODE_ENV — insertion order of the survivors.
 */

describe("RUNTIME_ENV_EXCLUDES", () => {
  it("is exactly PATH", () => {
    // Pinned as a list, not `.has("PATH")`: a key added here silently changes
    // what four runtimes strip from an operator's env.
    expect([...RUNTIME_ENV_EXCLUDES]).toEqual(["PATH"]);
  });

  it("drops every key it names", () => {
    // Derived from the set rather than hardcoded, so growing the list can't
    // leave splitRuntimeEnv behind.
    for (const key of RUNTIME_ENV_EXCLUDES) {
      expect(splitRuntimeEnv({ [key]: "x" })).toEqual({ entries: [], dropped: [key] });
    }
  });
});

describe("splitRuntimeEnv", () => {
  it("drops PATH and reports it", () => {
    expect(splitRuntimeEnv({ APP: "1", PATH: "/usr/bin", OTHER: "2" })).toEqual({
      entries: [
        ["APP", "1"],
        ["OTHER", "2"],
      ],
      dropped: ["PATH"],
    });
  });

  it("preserves insertion order of the survivors", () => {
    // Not alphabetical, and not the order a Set/Map iteration would produce:
    // callers concatenate these after their own PORT/NODE_ENV and docker lets
    // the LAST assignment of a key win, so reordering is a behaviour change.
    const env = {
      Z_LAST: "z",
      PATH: "/usr/bin",
      A_MIDDLE: "a",
      M_THEN: "m",
      B_END: "b",
    };
    expect(splitRuntimeEnv(env).entries).toEqual([
      ["Z_LAST", "z"],
      ["A_MIDDLE", "a"],
      ["M_THEN", "m"],
      ["B_END", "b"],
    ]);
  });

  it("keeps keys that merely CONTAIN PATH", () => {
    // A substring or regex filter here would delete real operator data.
    const env = {
      MY_PATH: "/opt/mine",
      PATHOLOGY: "chronic",
      PATH_EXTRA: "/extra",
      XPATH: "//div",
    };
    expect(splitRuntimeEnv(env)).toEqual({ entries: Object.entries(env), dropped: [] });
  });

  it("is case-sensitive: `path` and `Path` are different variables and are kept", () => {
    // Docker/POSIX env lookup is case-sensitive — no loader reads `path` for
    // command resolution, so dropping it would be data loss with no upside.
    const env = { path: "/lower/case", Path: "/mixed/case" };
    expect(splitRuntimeEnv(env)).toEqual({ entries: Object.entries(env), dropped: [] });
  });

  it("returns empty halves for an empty env", () => {
    expect(splitRuntimeEnv({})).toEqual({ entries: [], dropped: [] });
  });

  it("returns no entries when PATH is the only key", () => {
    expect(splitRuntimeEnv({ PATH: "/usr/local/bin:/usr/bin" })).toEqual({
      entries: [],
      dropped: ["PATH"],
    });
  });

  it("leaves an env with no excluded key byte-identical", () => {
    const env = { A: "1", B: "", C: "multi=sign=value" };
    expect(splitRuntimeEnv(env)).toEqual({ entries: Object.entries(env), dropped: [] });
  });
});

describe("droppedRuntimeEnvMessage", () => {
  it("is the empty string for no dropped keys", () => {
    // Exactly "" — the call sites gate their log on `dropped.length`, but a
    // whitespace-y "nothing was dropped" line would still read as a warning to
    // an operator if a site ever logged unconditionally.
    expect(droppedRuntimeEnvMessage([])).toBe("");
  });

  it("names the dropped key and ends with a newline", () => {
    // Wording may legitimately change; the key name and the terminator are the
    // contract (log surfaces concatenate raw, so a missing \n glues two lines).
    const message = droppedRuntimeEnvMessage(["PATH"]);
    expect(message).toContain("PATH");
    expect(message.endsWith("\n")).toBe(true);
  });

  it("names EVERY dropped key, on one line", () => {
    const message = droppedRuntimeEnvMessage(["PATH", "LD_PRELOAD"]);
    expect(message).toContain("PATH");
    expect(message).toContain("LD_PRELOAD");
    expect(message.endsWith("\n")).toBe(true);
    expect(message.trimEnd()).not.toContain("\n");
  });
});
