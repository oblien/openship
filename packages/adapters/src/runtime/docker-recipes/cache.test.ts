import { describe, expect, it } from "vitest";
import { cachedRunPrefix, generatedBuildIgnore } from "./cache";
import { generateDockerfile } from "../docker-build-plan";
import type { BuildConfig } from "../../types";

const config = {
  projectId: "project-a",
  sessionId: "first",
  repoUrl: "repo",
  branch: "main",
  stack: "nextjs",
  packageManager: "bun",
  buildImage: "node:22",
  runtimeImage: "node:22",
  installCommand: "bun install",
  buildCommand: "bun run build",
  envVars: { TOKEN: "secret" },
  rootDirectory: "apps/web",
  outputDirectory: ".next",
  buildCache: true,
  port: 3000,
  resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
} as BuildConfig;

describe("generated build cache mounts", () => {
  it("excludes generated session files from COPY without replacing repository ignore rules", () => {
    const contents = "node_modules\n!public\n";
    const result = generatedBuildIgnore(contents);
    expect(result.startsWith(contents)).toBe(true);
    expect(result).toContain("Dockerfile.openship*\n");
    expect(generatedBuildIgnore(result)).toBe(result);
  });
  it("reuses caches across commits and sessions while isolating projects and branches", () => {
    const first = cachedRunPrefix(config);
    expect(cachedRunPrefix({ ...config, sessionId: "second", commitSha: "new" })).toBe(first);
    expect(cachedRunPrefix({ ...config, projectId: "project-b" })).not.toBe(first);
    expect(cachedRunPrefix({ ...config, branch: "preview" })).not.toBe(first);
    expect(first).not.toContain("secret");
    expect(first).not.toContain("project-a");
  });

  it("keeps dependency downloads reusable but invalidates compilation caches on build environment changes", () => {
    const mounts = (c: BuildConfig) =>
      cachedRunPrefix(c)
        .split(" ")
        .filter((s) => s.startsWith("--mount"));
    const before = mounts(config),
      after = mounts({ ...config, envVars: { TOKEN: "changed" } });
    expect(before.find((s) => s.includes("/root/.bun/install/cache"))).toBe(
      after.find((s) => s.includes("/root/.bun/install/cache")),
    );
    expect(before.find((s) => s.includes("/.next/cache"))).not.toBe(
      after.find((s) => s.includes("/.next/cache")),
    );
  });

  it("keeps Yarn PnP package archives in image layers while caching build-only outputs", () => {
    const prefix = cachedRunPrefix({ ...config, packageManager: "yarn" });
    expect(prefix).not.toContain("target=/root/.yarn");
    expect(prefix).not.toContain("target=/usr/local/share/.cache/yarn");
    expect(prefix).toContain("target=/workspace/apps/web/.next/cache");
    expect(prefix).toContain("target=/workspace/.turbo/cache");
  });

  it("mounts package and framework caches at the correct monorepo paths without hiding build outputs", () => {
    const output = generateDockerfile(config);
    expect(output).toContain("ARG TARGETPLATFORM");
    expect(output).toContain("target=/workspace/apps/web/.next/cache,sharing=locked");
    expect(output).toContain("target=/workspace/.turbo/cache");
    expect(output).not.toContain("target=/workspace/apps/web/.next,");
    expect(output).not.toContain("target=/workspace/apps/web/node_modules");
    expect(output).toContain("COPY . /workspace");
    expect(cachedRunPrefix({ ...config, outputDirectory: ".next/cache" })).not.toContain(
      "target=/workspace/apps/web/.next/cache",
    );
  });

  it.each([
    "npm",
    "pnpm",
    "pip",
    "uv",
    "composer",
    "bundler",
    "cargo",
    "go",
    "maven",
    "gradle",
    "dotnet",
  ])("supports %s without a framework-specific code path", (packageManager) => {
    const prefix = cachedRunPrefix({ ...config, stack: "unknown", packageManager });
    expect(prefix).toContain("--mount=type=cache");
    expect(prefix).not.toContain("/.next/cache");
  });

  it("leaves legacy recipes unchanged and does not turn path delimiters into Docker mount options", () => {
    expect(cachedRunPrefix({ ...config, buildCache: false })).toBe("RUN ");
    expect(generateDockerfile({ ...config, buildCache: false })).not.toContain("--mount");
    expect(cachedRunPrefix({ ...config, buildImage: "example.com/custom-offline-builder:1" })).toBe(
      "RUN ",
    );
    expect(cachedRunPrefix({ ...config, rootDirectory: "web,from=host" })).not.toContain(
      "from=host",
    );
    expect(cachedRunPrefix({ ...config, stack: "nuxt" })).not.toContain(
      "target=/workspace/apps/web/.nuxt",
    );
  });
});
