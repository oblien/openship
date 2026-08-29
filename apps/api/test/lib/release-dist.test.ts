import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The download lives in release-download; mock it so these tests
// exercise ONLY the 3-slot resolution + latest-version logic (no network, no fs
// extraction). fetchAndExtractRelease → controllable.
vi.mock("../../src/lib/release-download", () => ({
  fetchAndExtractRelease: vi.fn(),
}));

// URL-mode version discovery is user-controlled and must go through the DNS-
// pinned safe client. Mock the transport, then assert the security policy the
// resolver hands it rather than touching the network.
vi.mock("../../src/lib/safe-fetch", () => ({ safeFetch: vi.fn() }));

import {
  resolveReleaseDist,
  resolveReleaseDistOrNull,
  resolveLatestReleaseVersion,
  resolveLatestVersion,
  resolveReleaseVersion,
  ReleaseDistMissingError,
  ReleaseVersionUnavailableError,
} from "../../src/lib/release-dist";
import { fetchAndExtractRelease } from "../../src/lib/release-download";
import { safeFetch } from "../../src/lib/safe-fetch";
import { env } from "../../src/config/env";
import type { ReleaseSource } from "@repo/core";

const fetchMock = fetchAndExtractRelease as unknown as ReturnType<typeof vi.fn>;
const safeFetchMock = safeFetch as unknown as ReturnType<typeof vi.fn>;

let root: string;
const ENV_KEY = "TEST_RELEASE_DIST_OVERRIDE";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "release-dist-"));
  fetchMock.mockReset();
  safeFetchMock.mockReset();
  delete process.env[ENV_KEY];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env[ENV_KEY];
});

const github: ReleaseSource = {
  mode: "github",
  repo: "oblien/openship",
  assetTemplate: "openship-{tag}-{os}-{arch}.tar.gz",
};

describe("resolveReleaseDist — slot order", () => {
  it("slot 1: env override (+ subdir) wins when it exists", async () => {
    const base = join(root, "checkout");
    mkdirSync(join(base, "dist"), { recursive: true });
    process.env[ENV_KEY] = base;

    const res = await resolveReleaseDist({
      name: "email",
      version: "1.0.0",
      source: github,
      envOverride: ENV_KEY,
      envOverrideSubdir: "dist",
      dataDir: join(root, "data"),
    });

    expect(res.origin).toBe("env");
    expect(res.dir).toBe(join(base, "dist"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("slot 1: a set-but-missing env override throws (no silent fallthrough)", async () => {
    process.env[ENV_KEY] = join(root, "does-not-exist");
    await expect(
      resolveReleaseDist({
        name: "email",
        version: "1.0.0",
        source: github,
        envOverride: ENV_KEY,
        envOverrideSubdir: "dist",
        dataDir: join(root, "data"),
      }),
    ).rejects.toBeInstanceOf(ReleaseDistMissingError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("slot 2: repo-local dev path when no env override", async () => {
    const repoLocal = join(root, "apps", "email", "dist");
    mkdirSync(repoLocal, { recursive: true });

    const res = await resolveReleaseDist({
      name: "email",
      version: "1.0.0",
      source: github,
      repoLocalPath: repoLocal,
      dataDir: join(root, "data"),
    });

    expect(res.origin).toBe("repo-local");
    expect(res.dir).toBe(repoLocal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("slot 3: cache hit at <dataDir>/<name>-dist/v<version>", async () => {
    const dataDir = join(root, "data");
    const cached = join(dataDir, "openship-dist", "v2.3.4");
    mkdirSync(cached, { recursive: true });

    const res = await resolveReleaseDist({
      name: "openship",
      version: "2.3.4",
      source: github,
      dataDir,
    });

    expect(res.origin).toBe("cache-hit");
    expect(res.dir).toBe(cached);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("slot 3: download on miss (github) renders the asset name from the version", async () => {
    const dataDir = join(root, "data");
    const downloaded = join(dataDir, "openship-dist", "v5.0.0");
    fetchMock.mockResolvedValue({ path: downloaded });

    const res = await resolveReleaseDist({
      name: "openship",
      version: "5.0.0",
      source: github,
      dataDir,
    });

    expect(res.origin).toBe("downloaded");
    expect(res.dir).toBe(downloaded);
    expect(res.asset).toBe("openship-v5.0.0-linux-amd64.tar.gz");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "oblien/openship",
        asset: "openship-v5.0.0-linux-amd64.tar.gz",
        tag: "v5.0.0",
      }),
    );
  });

  it("url mode: substitutes {version}/{tag} into distUrl and passes the sha256 through", async () => {
    const dataDir = join(root, "data");
    fetchMock.mockResolvedValue({ path: join(dataDir, "x-dist", "v1.1.0") });
    const source: ReleaseSource = {
      mode: "url",
      distUrl: "https://cdn.example.com/x-{version}.tar.gz",
      sha256: "a".repeat(64),
    };

    const res = await resolveReleaseDist({ name: "x", version: "1.1.0", source, dataDir });

    expect(res.origin).toBe("downloaded");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assetUrl: "https://cdn.example.com/x-1.1.0.tar.gz",
        sha256: "a".repeat(64),
      }),
    );
  });

  it("wraps a download failure in ReleaseDistMissingError (with cause)", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    await expect(
      resolveReleaseDist({
        name: "openship",
        version: "9.9.9",
        source: github,
        dataDir: join(root, "data"),
      }),
    ).rejects.toBeInstanceOf(ReleaseDistMissingError);
  });
});

describe("resolveReleaseDistOrNull — no download", () => {
  it("returns the cached dir when present, null otherwise (never downloads)", () => {
    const dataDir = join(root, "data");
    expect(
      resolveReleaseDistOrNull({ name: "openship", version: "1.0.0", source: github, dataDir }),
    ).toBeNull();

    const cached = join(dataDir, "openship-dist", "v1.0.0");
    mkdirSync(cached, { recursive: true });
    expect(
      resolveReleaseDistOrNull({ name: "openship", version: "1.0.0", source: github, dataDir }),
    ).toBe(cached);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("resolveLatestVersion", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("github: keeps the publisher's raw tag alongside the normalized version", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: "v3.4.5" }),
    }) as unknown as typeof fetch;

    expect(await resolveLatestReleaseVersion(github)).toEqual({
      version: "3.4.5",
      tag: "v3.4.5",
    });
  });

  it("keeps resolveLatestVersion as a normalized-string compatibility API", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: "v3.4.5" }),
    }) as unknown as typeof fetch;
    expect(await resolveLatestVersion(github)).toBe("3.4.5");
  });

  it("url: reads a bare version through the DNS-pinned, redirect-safe client", async () => {
    const nativeFetch = vi.fn();
    globalThis.fetch = nativeFetch as unknown as typeof fetch;
    safeFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "v7.8.9\n",
    });
    const source: ReleaseSource = {
      mode: "url",
      distUrl: "https://cdn/x-{version}.tgz",
      versionUrl: "https://cdn/latest.txt",
    };

    expect(await resolveLatestReleaseVersion(source)).toEqual({
      version: "7.8.9",
      tag: "v7.8.9",
    });
    expect(await resolveLatestVersion(source)).toBe("7.8.9");
    expect(safeFetchMock).toHaveBeenCalledWith("https://cdn/latest.txt", {
      headers: { "User-Agent": "openship" },
      timeoutMs: 10_000,
      maxRedirects: 5,
      maxBodyBytes: 8192,
      allowPrivate: !env.CLOUD_MODE,
    });
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("url: parses JSON version and tag_name bodies without losing the raw tag", async () => {
    safeFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ version: "10.0.1" }),
    });
    const source: ReleaseSource = {
      mode: "url",
      distUrl: "https://cdn/x.tgz",
      versionUrl: "https://cdn/latest.json",
    };
    expect(await resolveLatestReleaseVersion(source)).toEqual({
      version: "10.0.1",
      tag: "10.0.1",
    });

    safeFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ tag_name: "v10.0.2" }),
    });
    expect(await resolveLatestReleaseVersion(source)).toEqual({
      version: "10.0.2",
      tag: "v10.0.2",
    });
  });

  it("url: fails soft when the SSRF-safe client rejects the target", async () => {
    safeFetchMock.mockRejectedValue(new Error("SSRF_BLOCKED"));
    const source: ReleaseSource = {
      mode: "url",
      versionUrl: "https://metadata.internal/latest",
    };

    await expect(resolveLatestReleaseVersion(source)).resolves.toBeNull();
  });

  it("url with no versionUrl → null (no drift source)", async () => {
    expect(await resolveLatestVersion({ mode: "url", distUrl: "https://cdn/x.tgz" })).toBeNull();
    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});

describe("resolveReleaseVersion", () => {
  it("uses explicit input, then pinnedVersion, without consulting upstream", async () => {
    const source: ReleaseSource = {
      mode: "url",
      versionUrl: "https://cdn/latest.txt",
      pinnedVersion: "v2.0.0",
    };

    await expect(resolveReleaseVersion(source, { version: "v1.4.0" })).resolves.toEqual({
      version: "1.4.0",
      tag: "v1.4.0",
    });
    await expect(resolveReleaseVersion(source)).resolves.toEqual({
      version: "2.0.0",
      tag: "v2.0.0",
    });
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("throws a typed error instead of borrowing Openship's API version", async () => {
    safeFetchMock.mockRejectedValue(new Error("upstream unavailable"));
    const source: ReleaseSource = {
      mode: "url",
      versionUrl: "https://cdn.example.com/latest.txt",
    };

    const failure = resolveReleaseVersion(source);
    await expect(failure).rejects.toBeInstanceOf(ReleaseVersionUnavailableError);
    await expect(resolveReleaseVersion(source)).rejects.toMatchObject({
      code: "RELEASE_VERSION_UNAVAILABLE",
      message: expect.stringContaining("Set pinnedVersion"),
    });
  });
});
