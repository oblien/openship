import { describe, expect, it, vi } from "vitest";
import {
  assertArtifactSha256,
  parseLockfileHashes,
  prepareRelease,
  resolveArtifactSource,
  reuseBuilderCacheCommand,
  shouldSkipPrepare,
} from "./release-driver";
import { mountedReleaseBuildMode } from "./mounted-release.config";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("upload buildMode", () => {
  it("is accepted as a mounted-release config value", () => {
    expect(mountedReleaseBuildMode({ enabled: true, containerPath: "/app", buildMode: "upload" })).toBe(
      "upload",
    );
    expect(resolveArtifactSource({ enabled: true, containerPath: "/app", buildMode: "upload" })).toBe(
      "local-upload",
    );
    expect(mountedReleaseBuildMode({ enabled: true, containerPath: "/app" })).toBe("prebuilt");
    expect(
      mountedReleaseBuildMode({
        enabled: true,
        containerPath: "/app",
        prepareCommand: "composer install",
      }),
    ).toBe("server");
  });
});

describe("assertArtifactSha256", () => {
  it("refuses activation when the digest does not match", () => {
    expect(() => assertArtifactSha256(SHA_A, SHA_B)).toThrow(/does not match|Activation refused/);
    try {
      assertArtifactSha256(SHA_A, SHA_B);
      throw new Error("expected SHA mismatch");
    } catch (error) {
      expect(error).toMatchObject({ code: "ARTIFACT_SHA_MISMATCH" });
    }
    expect(() => assertArtifactSha256("not-a-hash", SHA_A)).toThrow(/Activation refused/);
  });

  it("accepts a matching digest with optional sha256: prefix", () => {
    expect(() => assertArtifactSha256(SHA_A, SHA_A.toUpperCase())).not.toThrow();
    expect(() => assertArtifactSha256(SHA_A, `sha256:${SHA_A}`)).not.toThrow();
  });
});

describe("lock hash skip/run", () => {
  it("skips prepare when every lockfile hash matches the previous ready release", () => {
    const hashes = { "composer.lock": SHA_A, "package-lock.json": SHA_B };
    expect(shouldSkipPrepare(hashes, { ...hashes })).toBe(true);
  });

  it("runs prepare when a lockfile hash changed, appeared, or vanished", () => {
    expect(shouldSkipPrepare({ "composer.lock": SHA_A }, { "composer.lock": SHA_B })).toBe(false);
    expect(shouldSkipPrepare({ "composer.lock": SHA_A }, { "package-lock.json": SHA_A })).toBe(false);
    expect(shouldSkipPrepare({ "composer.lock": SHA_A }, {})).toBe(false);
    expect(shouldSkipPrepare({}, { "composer.lock": SHA_A })).toBe(false);
    expect(shouldSkipPrepare({ "composer.lock": SHA_A }, null)).toBe(false);
  });

  it("parses sha256sum output into lockfile names", () => {
    expect(
      parseLockfileHashes(
        `${SHA_A}  /var/lib/openship/mounted-releases/p/releases/d/composer.lock\n` +
          `${SHA_B}  /var/lib/openship/mounted-releases/p/releases/d/package-lock.json\n`,
      ),
    ).toEqual({ "composer.lock": SHA_A, "package-lock.json": SHA_B });
  });

  it("reuses cached vendor/node_modules from builder-cache when skipping", () => {
    const cmd = reuseBuilderCacheCommand(
      "/var/lib/openship/mounted-releases/p",
      "/var/lib/openship/mounted-releases/p/releases/d",
      ["vendor", "node_modules"],
    );
    expect(cmd).toContain("builder-cache/paths/vendor");
    expect(cmd).toContain("releases/d/vendor");
    expect(cmd).toContain("cp -a");
  });

  it("falls back to the previous ready tree when builder-cache is empty", () => {
    const cmd = reuseBuilderCacheCommand(
      "/var/lib/openship/mounted-releases/p",
      "/var/lib/openship/mounted-releases/p/releases/d",
      ["vendor"],
      "/var/lib/openship/mounted-releases/p/releases/prev",
    );
    expect(cmd).toContain("releases/prev/vendor");
    expect(cmd).toMatch(/elif \[ -d /);
  });
});

describe("prepareRelease local-upload", () => {
  it("verifies SHA-256 before extract and refuses a mismatch", async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes("sha256sum")) return `${SHA_B}\n`;
      return "";
    });
    const runPrepare = vi.fn();
    await expect(
      prepareRelease({
        exec,
        config: { enabled: true, containerPath: "/app", buildMode: "upload" },
        hostRoot: "/var/lib/openship/mounted-releases/p",
        releaseDir: "/var/lib/openship/mounted-releases/p/releases/d",
        incoming: "/var/lib/openship/mounted-releases/p/.incoming-d",
        deploymentId: "d",
        uploadedArchive: "/tmp/app.tar.gz",
        claimedSha256: SHA_A,
        runPrepare,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_SHA_MISMATCH" });
    expect(runPrepare).not.toHaveBeenCalled();
    expect(exec.mock.calls.some(([cmd]) => String(cmd).includes("tar -xaf"))).toBe(false);
  });

  it("extracts after a matching digest", async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes("sha256sum") && cmd.includes("/tmp/app.tar.gz")) return `${SHA_A}\n`;
      if (cmd.startsWith("for f in")) return `${SHA_A}  /rel/composer.lock\n`;
      return "";
    });
    const prepared = await prepareRelease({
      exec,
      config: { enabled: true, containerPath: "/app", buildMode: "upload" },
      hostRoot: "/var/lib/openship/mounted-releases/p",
      releaseDir: "/var/lib/openship/mounted-releases/p/releases/d",
      incoming: "/var/lib/openship/mounted-releases/p/.incoming-d",
      deploymentId: "d",
      uploadedArchive: "/tmp/app.tar.gz",
      claimedSha256: SHA_A,
      runPrepare: vi.fn(),
    });
    expect(prepared.sha256).toBe(SHA_A);
    expect(prepared.provenance.source).toBe("local-upload");
    expect(prepared.provenance.lockHashes).toEqual({ "composer.lock": SHA_A });
    expect(exec.mock.calls.some(([cmd]) => String(cmd).includes("tar -xaf"))).toBe(true);
  });
});

describe("prepareRelease server-prepared lock skip", () => {
  it("skips prepareCommand when lock hashes match the previous release", async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.startsWith("for f in")) return `${SHA_A}  /rel/composer.lock\n`;
      return "";
    });
    const runPrepare = vi.fn();
    const prepared = await prepareRelease({
      exec,
      config: {
        enabled: true,
        containerPath: "/app",
        buildMode: "server",
        prepareCommand: "composer install",
        builderCachePaths: ["vendor"],
      },
      hostRoot: "/var/lib/openship/mounted-releases/p",
      releaseDir: "/var/lib/openship/mounted-releases/p/releases/d",
      incoming: "/var/lib/openship/mounted-releases/p/.incoming-d",
      deploymentId: "d",
      commitSha: "abc123",
      previousLockHashes: { "composer.lock": SHA_A },
      runPrepare,
    });
    expect(prepared.skippedPrepare).toBe(true);
    expect(runPrepare).not.toHaveBeenCalled();
    expect(exec.mock.calls.some(([cmd]) => String(cmd).includes("builder-cache/paths/vendor"))).toBe(
      true,
    );
  });

  it("runs prepare when the lock hash changed", async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.startsWith("for f in")) return `${SHA_B}  /rel/composer.lock\n`;
      return "";
    });
    const runPrepare = vi.fn();
    const prepared = await prepareRelease({
      exec,
      config: {
        enabled: true,
        containerPath: "/app",
        buildMode: "server",
        prepareCommand: "composer install",
      },
      hostRoot: "/var/lib/openship/mounted-releases/p",
      releaseDir: "/var/lib/openship/mounted-releases/p/releases/d",
      incoming: "/var/lib/openship/mounted-releases/p/.incoming-d",
      deploymentId: "d",
      commitSha: "abc123",
      previousLockHashes: { "composer.lock": SHA_A },
      runPrepare,
    });
    expect(prepared.skippedPrepare).toBe(false);
    expect(runPrepare).toHaveBeenCalledOnce();
  });
});
