import { describe, it, expect } from "vitest";
import {
  compareCommitSha,
  digestSha,
  identityLabel,
  isBehind,
  isFullCommitSha,
  type UpdatableIdentity,
} from "./identity";

/**
 * The reported failure: a project deployed at `1eeaf76` was offered `1eeaf76` as a
 * new commit, permanently. The deploy API accepts any git ref as `commitSha`, git
 * checks an abbreviation out happily, and every surface renders `slice(0, 7)` — so
 * a byte comparison against the 40-char branch HEAD showed one commit as two and
 * printed the same sha on both sides of the nudge.
 */
describe("compareCommitSha", () => {
  const FULL = "1eeaf7692a19ee6e7ecb64b9d1a5c3ee7c0ac2f5";

  it("an abbreviation names the same commit, in either position", () => {
    expect(compareCommitSha(FULL, "1eeaf76")).toBe("same");
    expect(compareCommitSha("1eeaf76", FULL)).toBe("same");
    expect(compareCommitSha(FULL, FULL)).toBe("same");
  });

  it("ignores surrounding whitespace and case", () => {
    expect(compareCommitSha(FULL, ` ${FULL.toUpperCase()}\n`)).toBe("same");
  });

  it("still reports a real difference", () => {
    expect(compareCommitSha(FULL, "282619c7aabbccddeeff00112233445566778899")).toBe("different");
    expect(compareCommitSha(FULL, "282619c")).toBe("different");
  });

  it("a ref that isn't a sha is unknown, never drift", () => {
    // A tag or branch pinned as `--commit` can't be compared by value; claiming
    // "different" is what pins a nudge on forever.
    expect(compareCommitSha(FULL, "v1.2.3")).toBe("unknown");
    expect(compareCommitSha(FULL, "HEAD")).toBe("unknown");
    expect(compareCommitSha(FULL, null)).toBe("unknown");
    expect(compareCommitSha(null, undefined)).toBe("unknown");
  });

  it("a prefix below git's abbreviation floor is unknown, not a guess", () => {
    expect(compareCommitSha(FULL, "1eea")).toBe("unknown");
    expect(compareCommitSha(FULL, "1eeaf7")).toBe("unknown");
  });
});

describe("isFullCommitSha", () => {
  it("accepts only a canonical 40-hex sha", () => {
    expect(isFullCommitSha("1eeaf7692a19ee6e7ecb64b9d1a5c3ee7c0ac2f5")).toBe(true);
    expect(isFullCommitSha("1eeaf76")).toBe(false);
    expect(isFullCommitSha("v1.2.3")).toBe(false);
    expect(isFullCommitSha(null)).toBe(false);
  });
});

describe("isBehind", () => {
  it("release: lower semver is behind", () => {
    expect(
      isBehind({ kind: "release", version: "0.3.0" }, { kind: "release", version: "0.3.1" }),
    ).toBe(true);
    expect(
      isBehind({ kind: "release", version: "0.3.1" }, { kind: "release", version: "0.3.1" }),
    ).toBe(false);
    expect(
      isBehind({ kind: "release", version: "1.0.0" }, { kind: "release", version: "0.9.9" }),
    ).toBe(false);
  });

  it("commit: differing sha is behind, equal is not", () => {
    expect(isBehind({ kind: "commit", sha: "aaa" }, { kind: "commit", sha: "bbb" })).toBe(true);
    expect(isBehind({ kind: "commit", sha: "aaa" }, { kind: "commit", sha: "aaa" })).toBe(false);
    // Missing a sha → no evidence → not behind.
    expect(isBehind({ kind: "commit", sha: "" }, { kind: "commit", sha: "bbb" })).toBe(false);
  });

  it("commit: an abbreviated sha is not a new commit", () => {
    const full = "1eeaf7692a19ee6e7ecb64b9d1a5c3ee7c0ac2f5";
    expect(isBehind({ kind: "commit", sha: "1eeaf76" }, { kind: "commit", sha: full })).toBe(false);
  });

  it("image: compares the sha256 suffix across repo@ / bare forms", () => {
    const current: UpdatableIdentity = {
      kind: "image",
      ref: "n8nio/n8n:latest",
      digest: "n8nio/n8n@sha256:aaaa",
    };
    const moved: UpdatableIdentity = {
      kind: "image",
      ref: "n8nio/n8n:latest",
      digest: "sha256:bbbb", // registry-form, no repo prefix
    };
    const same: UpdatableIdentity = { kind: "image", ref: "n8nio/n8n:latest", digest: "sha256:aaaa" };
    expect(isBehind(current, moved)).toBe(true);
    expect(isBehind(current, same)).toBe(false);
  });

  it("image: unknown digest on either side → not behind unless ref differs", () => {
    expect(
      isBehind(
        { kind: "image", ref: "n8nio/n8n:latest" },
        { kind: "image", ref: "n8nio/n8n:latest", digest: "sha256:x" },
      ),
    ).toBe(false);
    expect(
      isBehind(
        { kind: "image", ref: "n8nio/n8n:1.0" },
        { kind: "image", ref: "n8nio/n8n:1.1" },
      ),
    ).toBe(true);
  });

  it("mismatched kinds never claim drift", () => {
    expect(isBehind({ kind: "commit", sha: "a" }, { kind: "release", version: "1.0.0" })).toBe(false);
  });
});

describe("digestSha", () => {
  it("extracts the sha256 from repo@ and bare forms", () => {
    expect(digestSha("n8nio/n8n@sha256:abc")).toBe("sha256:abc");
    expect(digestSha("sha256:abc")).toBe("sha256:abc");
    expect(digestSha(undefined)).toBeUndefined();
  });
});

describe("identityLabel", () => {
  it("renders a compact label per kind", () => {
    expect(identityLabel({ kind: "commit", sha: "abcdef1234" })).toBe("abcdef1");
    expect(identityLabel({ kind: "release", version: "0.3.1" })).toBe("0.3.1");
    expect(identityLabel({ kind: "image", ref: "n8nio/n8n:latest" })).toBe("n8nio/n8n:latest");
  });
});
