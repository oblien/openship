import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  dockerBuildContextDirectory,
  normalizeDockerRelativePath,
  normalizeDockerRootDirectory,
  resolveContextDockerfileCandidates,
  resolveDockerfileCandidates,
  resolveWithinDirectory,
} from "./docker-paths";

/**
 * GHSA-443m-7g52-94w8. A project's `rootDirectory` reached three sinks
 * unchecked: join() onto the host build-context temp dir (then tarred and
 * uploaded to the caller's cloud workspace), `WORKDIR /workspace/${...}` in
 * generated Dockerfiles, and the Dockerfile read itself. `"../.."` resolved to
 * `/` on the host.
 */
const TRAVERSALS = [
  "..",
  "../..",
  "../../..",
  "./../..",
  "../../etc",
  "../../../etc/ssh",
  "apps/../../..",
  "apps/web/../../../../etc",
  "/../../etc",
];

// Legal (if odd) directory names that merely LOOK like traversal. Rejecting
// these would break real repos, and percent-decoding at this layer would
// invent a traversal that the filesystem never sees.
const NOT_TRAVERSAL = ["my..app", "..foo", "...", "..%2f..", "a..b/c"];

// A Windows control plane hands these over verbatim. The old code split on the
// platform `sep`, so on a Linux API server "..\\.." was one segment that never
// equalled "..".
const WINDOWS_TRAVERSALS = ["..\\..", "..\\..\\etc", "apps\\..\\..\\.."];

describe("normalizeDockerRelativePath", () => {
  it.each([...TRAVERSALS, ...WINDOWS_TRAVERSALS])("rejects %j", (value) => {
    expect(() => normalizeDockerRelativePath(value)).toThrow(/must not contain/);
  });

  it.each([
    ["apps/web", "apps/web"],
    ["./apps/web", "apps/web"],
    ["/apps/web/", "apps/web"],
    ["apps\\web", "apps/web"],
    ["apps//web", "apps/web"],
    ["packages/ui/src", "packages/ui/src"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeDockerRelativePath(input)).toBe(expected);
  });

  it.each(NOT_TRAVERSAL)("keeps %j, which only looks like traversal", (value) => {
    expect(normalizeDockerRelativePath(value)).toBe(value);
  });

  it.each([undefined, null, "", "  ", ".", "./", "/"])("treats %j as repo root", (value) => {
    expect(normalizeDockerRelativePath(value)).toBe("");
  });
});

describe("normalizeDockerRootDirectory", () => {
  // The `..` check used to live inside the `isAbsolute(normalized)` branch, so
  // a plain relative "../.." skipped it entirely — this is the reported bug.
  it.each(TRAVERSALS)("rejects relative traversal %j with no localPath", (value) => {
    expect(() => normalizeDockerRootDirectory(value)).toThrow(/must not contain/);
  });

  it.each(TRAVERSALS)("rejects relative traversal %j with a localPath", (value) => {
    expect(() => normalizeDockerRootDirectory(value, "/home/deploy/repo")).toThrow(
      /must not contain/,
    );
  });

  it.each(WINDOWS_TRAVERSALS)("rejects backslash traversal %j", (value) => {
    expect(() => normalizeDockerRootDirectory(value)).toThrow(/must not contain/);
  });

  it("still rebases an absolute path that sits under localPath", () => {
    expect(normalizeDockerRootDirectory("/home/deploy/repo/apps/web", "/home/deploy/repo")).toBe(
      "apps/web",
    );
  });

  it("treats an absolute path equal to localPath as repo root", () => {
    expect(normalizeDockerRootDirectory("/home/deploy/repo", "/home/deploy/repo")).toBe("");
  });

  it.each([
    ["apps/web", "apps/web"],
    ["./apps/web", "apps/web"],
    ["apps/web/", "apps/web"],
  ])("passes through %j", (input, expected) => {
    expect(normalizeDockerRootDirectory(input)).toBe(expected);
  });

  it.each([undefined, "", "  ", ".", "/"])("treats %j as repo root", (value) => {
    expect(normalizeDockerRootDirectory(value)).toBe("");
  });
});

describe("resolveDockerfileCandidates", () => {
  it("rejects a traversing rootDirectory", () => {
    expect(() => resolveDockerfileCandidates("../..", "Dockerfile")).toThrow(/must not contain/);
  });

  it("rejects a traversing dockerfilePath", () => {
    expect(() => resolveDockerfileCandidates("apps/web", "../../../etc/passwd")).toThrow(
      /must not contain/,
    );
  });

  it("still builds the normal candidate list", () => {
    expect(resolveDockerfileCandidates("apps/web", "Dockerfile.prod")).toEqual([
      "apps/web/Dockerfile.prod",
      "apps/web/Dockerfile",
      "Dockerfile",
    ]);
  });
});

describe("resolveWithinDirectory", () => {
  const base = "/tmp/openship-docker-context-abc";

  it.each([...TRAVERSALS, ...WINDOWS_TRAVERSALS])("refuses to resolve %j", (value) => {
    expect(() => resolveWithinDirectory(base, value)).toThrow(/must not contain/);
  });

  it("resolves a nested sub-path", () => {
    expect(resolveWithinDirectory(base, "apps/web")).toBe(join(base, "apps", "web"));
  });

  it.each([undefined, null, "", ".", "./"])("resolves %j to the base itself", (value) => {
    expect(resolveWithinDirectory(base, value)).toBe(base);
  });

  it.each(NOT_TRAVERSAL)("still resolves %j, which only looks like traversal", (value) => {
    expect(resolveWithinDirectory(base, value)).toBe(join(base, value));
  });

  // An absolute value is contained rather than honoured: "/etc" must not read
  // the host's /etc, it becomes <base>/etc and fails to exist.
  it("contains an absolute sub-path instead of following it", () => {
    expect(resolveWithinDirectory(base, "/etc/ssh")).toBe(join(base, "etc", "ssh"));
  });
});

/**
 * #634. A compose service's `build` is a build CONTEXT, so its `dockerfile` is
 * resolved INSIDE that context, and the candidate list must be relative to it —
 * that string is what reaches `docker build -f`.
 */
describe("dockerBuildContextDirectory", () => {
  it.each([undefined, null, "", ".", "./", "/"])("reads %j as the source root", (value) => {
    expect(dockerBuildContextDirectory({ buildContextDirectory: value as never })).toBe("");
  });

  it("normalizes a declared context", () => {
    expect(dockerBuildContextDirectory({ buildContextDirectory: "./svc/api/" })).toBe("svc/api");
  });

  it("rejects a traversing context", () => {
    expect(() => dockerBuildContextDirectory({ buildContextDirectory: "../.." })).toThrow(
      /must not contain/,
    );
  });
});

describe("resolveContextDockerfileCandidates", () => {
  it("resolves the dockerfile INSIDE the context", () => {
    expect(resolveContextDockerfileCandidates("dinohash-service", "Dockerfile")).toEqual([
      "Dockerfile",
    ]);
    expect(resolveContextDockerfileCandidates("svc", "docker/Dockerfile.prod")).toEqual([
      "docker/Dockerfile.prod",
      "Dockerfile",
    ]);
  });

  // The one candidate that must NOT be here is the SOURCE-ROOT Dockerfile: it sits
  // outside the context, so falling back to it would build a different image under
  // this service's tag — which is what the whole-repo context used to allow.
  it("never falls back outside the context", () => {
    expect(resolveContextDockerfileCandidates("svc", "Dockerfile.api")).toEqual([
      "Dockerfile.api",
      "Dockerfile",
    ]);
  });

  it("tolerates a dockerfile that already carries the context prefix", () => {
    // How the field was filled while the context WAS the repo root. The strict
    // compose reading is still tried first.
    expect(resolveContextDockerfileCandidates("svc", "svc/Dockerfile.prod")).toEqual([
      "svc/Dockerfile.prod",
      "Dockerfile.prod",
      "Dockerfile",
    ]);
  });

  it("defaults to the context's own Dockerfile", () => {
    expect(resolveContextDockerfileCandidates("svc", undefined)).toEqual(["Dockerfile"]);
    expect(resolveContextDockerfileCandidates("", null)).toEqual(["Dockerfile"]);
  });

  it("rejects a traversing dockerfilePath", () => {
    expect(() => resolveContextDockerfileCandidates("svc", "../../etc/passwd")).toThrow(
      /must not contain/,
    );
  });
});
