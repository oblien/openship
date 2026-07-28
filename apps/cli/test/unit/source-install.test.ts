import { describe, expect, it } from "vitest";

import { parseRemoteSha, parseSourceInstall } from "../../src/lib/source-install";

describe("parseSourceInstall", () => {
  it("parses a full marker", () => {
    const s = parseSourceInstall(
      JSON.stringify({ repo: "https://example.com/y.git", ref: "dev", dir: "/tmp/src" }),
    );
    expect(s).toEqual({ repo: "https://example.com/y.git", ref: "dev", dir: "/tmp/src" });
  });

  it("fills repo/ref defaults when omitted", () => {
    const s = parseSourceInstall(JSON.stringify({ dir: "/tmp/src" }));
    expect(s?.dir).toBe("/tmp/src");
    expect(s?.ref).toBe("main");
    expect(s?.repo).toBe("https://github.com/oblien/openship.git");
  });

  it("returns null without a dir (not a source install)", () => {
    expect(parseSourceInstall(JSON.stringify({ ref: "dev" }))).toBeNull();
    expect(parseSourceInstall(JSON.stringify({ dir: "" }))).toBeNull();
  });

  it("returns null on non-JSON / empty input", () => {
    expect(parseSourceInstall("not json")).toBeNull();
    expect(parseSourceInstall("")).toBeNull();
  });
});

describe("parseRemoteSha", () => {
  it("extracts the first-column sha from git ls-remote output", () => {
    const out = "1234567890abcdef1234567890abcdef12345678\trefs/heads/main\n";
    expect(parseRemoteSha(out)).toBe("1234567");
  });

  it("returns null on empty or malformed output", () => {
    expect(parseRemoteSha("")).toBeNull();
    expect(parseRemoteSha("garbage line\n")).toBeNull();
  });
});
