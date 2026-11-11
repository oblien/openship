import { describe, it, expect } from "vitest";
import {
  compareCommitSha,
  digestSha,
  identityLabel,
  isBehind,
  isFullCommitSha,
  resolveUnknownDigestDrift,
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

describe("unknown deployed image evidence", () => {
  const running = `sha256:${"1".repeat(64)}`;
  const tag = `sha256:${"2".repeat(64)}`;
  const deployedDigest = `registry.example/app@sha256:${"a".repeat(64)}`;
  const latest = `sha256:${"b".repeat(64)}`;

  it("uses the running image's repository digest even when the local tag is missing", () => {
    expect(resolveUnknownDigestDrift({
      containerImageId: running, containerRegistryDigest: deployedDigest, latestDigest: latest,
    })).toEqual({ behind: true, unknown: false, recoveredDigest: deployedDigest });
  });

  it("does not treat an unrelated local retag as newer than verified registry content", () => {
    expect(resolveUnknownDigestDrift({
      containerImageId: running, containerRegistryDigest: deployedDigest,
      tagImageId: tag, tagRegistryDigest: `registry.example/app@${latest}`,
      latestDigest: deployedDigest,
    })).toEqual({ behind: false, unknown: false, recoveredDigest: deployedDigest });
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

/**
 * The reported failure: `GET /api/updates?behind=1` returned `[]` for a service
 * whose container ran an older image than its tag now points to. The active
 * `service_deployment` row had `image_digest` NULL (carried forward by a
 * per-service update), so `isBehind` — which only compares digests when both
 * are known — fell back to the equal ref strings and reported "up to date".
 * The deployed side was unknown, not equal. When the database row has no
 * digest, the local daemon is the only witness: compare the running
 * container's image ID with the image ID the tag resolves to right now.
 */
describe("resolveUnknownDigestDrift", () => {
  const OLD_IMAGE = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  const NEW_IMAGE = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
  const REGISTRY_DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const TAG_REPO_DIGEST = `docker.io/library/nginx@${REGISTRY_DIGEST}`;

  it("a container on a different image from its tag is behind", () => {
    // The reported case: the local tag was re-pulled, the container kept the
    // old image, the row has no digest. A redeploy would recreate it.
    expect(
      resolveUnknownDigestDrift({
        containerImageId: OLD_IMAGE,
        tagImageId: NEW_IMAGE,
        latestDigest: REGISTRY_DIGEST,
      }),
    ).toEqual({ behind: true, unknown: false });
  });

  it("a differing local image is behind even when the digests would agree", () => {
    // The container's content differs from what the tag points to locally.
    // That is drift by itself — the registry comparison must not overrule it.
    expect(
      resolveUnknownDigestDrift({
        containerImageId: OLD_IMAGE,
        tagImageId: NEW_IMAGE,
        tagRegistryDigest: TAG_REPO_DIGEST,
        latestDigest: REGISTRY_DIGEST,
      }),
    ).toEqual({ behind: true, unknown: false });
  });

  it("matching images with matching digests are current, and the digest is recovered", () => {
    expect(
      resolveUnknownDigestDrift({
        containerImageId: NEW_IMAGE,
        tagImageId: NEW_IMAGE,
        tagRegistryDigest: TAG_REPO_DIGEST,
        latestDigest: REGISTRY_DIGEST,
      }),
    ).toEqual({ behind: false, unknown: false, recoveredDigest: TAG_REPO_DIGEST });
  });

  it("matching images with a moved registry tag are behind", () => {
    expect(
      resolveUnknownDigestDrift({
        containerImageId: NEW_IMAGE,
        tagImageId: NEW_IMAGE,
        tagRegistryDigest: TAG_REPO_DIGEST,
        latestDigest:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ).toEqual({ behind: true, unknown: false, recoveredDigest: TAG_REPO_DIGEST });
  });

  it("matching images with no digest anywhere stay unknown, not current", () => {
    // The container runs what the tag points to, but without a digest the
    // registry question is unanswerable — an image from `docker load` has no
    // RepoDigests, and the registry may still have moved the tag.
    expect(
      resolveUnknownDigestDrift({ containerImageId: NEW_IMAGE, tagImageId: NEW_IMAGE }),
    ).toEqual({ behind: false, unknown: true });
  });

  it("a missing container or an unresolvable tag stays unknown", () => {
    expect(resolveUnknownDigestDrift({ tagImageId: NEW_IMAGE })).toEqual({
      behind: false,
      unknown: true,
    });
    expect(resolveUnknownDigestDrift({ containerImageId: OLD_IMAGE })).toEqual({
      behind: false,
      unknown: true,
    });
    expect(resolveUnknownDigestDrift({})).toEqual({ behind: false, unknown: true });
  });
});
