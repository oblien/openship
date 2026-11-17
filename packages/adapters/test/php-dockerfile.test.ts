import { describe, expect, it } from "vitest";

import { generateDockerfile } from "../src/runtime/docker-build-plan";
import type { BuildConfig } from "../src/types";

function phpConfig(overrides: Partial<BuildConfig> = {}): BuildConfig {
  return {
    sessionId: "s1",
    projectId: "p1",
    repoUrl: "https://github.com/example/laravel-app.git",
    branch: "main",
    stack: "laravel",
    buildImage: "php:8.4-cli",
    runtimeImage: "dunglas/frankenphp:1-php8.4-bookworm",
    packageManager: "composer",
    installCommand: "composer install",
    buildCommand: "",
    startCommand: "frankenphp run",
    outputDirectory: "public",
    port: 8000,
    envVars: {},
    ...overrides,
  } as BuildConfig;
}

function builderStage(dockerfile: string): string {
  return dockerfile.split(/FROM \S+ AS runtime/)[0] ?? "";
}

function runtimeStage(dockerfile: string): string {
  const parts = dockerfile.split(/FROM \S+ AS runtime/);
  return parts[1] ?? "";
}

describe("generateDockerfile — PHP recipe", () => {
  it("starts builder and runtime stages with USER root to support non-root base images", () => {
    const df = generateDockerfile(phpConfig());
    const builder = builderStage(df);
    const runtime = runtimeStage(df);

    // Builder stage immediately resets to root
    const builderLines = builder.trim().split("\n");
    expect(builderLines[0]).toMatch(/^FROM \S+ AS builder$/);
    expect(builderLines[1]).toBe("USER root");

    // Runtime stage immediately resets to root
    const runtimeLines = runtime.trim().split("\n");
    expect(runtimeLines[0]).toBe("USER root");
  });

  it("resets to USER root when custom buildImage or runtimeImage override is supplied", () => {
    const df = generateDockerfile(
      phpConfig({
        buildImage: "serversideup/php:8.4-cli",
        runtimeImage: "serversideup/php:8.4-fpm-apache",
        runtimeImageOverride: true,
      }),
    );

    const builder = builderStage(df);
    const runtime = runtimeStage(df);

    expect(builder).toContain("FROM serversideup/php:8.4-cli AS builder\nUSER root");
    expect(runtime.trim().startsWith("USER root")).toBe(true);
  });

  it("installs php extensions while running as root before dropping privileges", () => {
    const df = generateDockerfile(phpConfig());
    const builder = builderStage(df);
    const runtime = runtimeStage(df);

    // In builder: USER root appears before install-php-extensions
    expect(builder.indexOf("USER root")).toBeLessThan(
      builder.indexOf("install-php-extensions"),
    );

    // In runtime: USER root appears before install-php-extensions
    expect(runtime.indexOf("USER root")).toBeLessThan(
      runtime.indexOf("install-php-extensions"),
    );
  });

  it("performs directory setup and cleanup before dropping privileges to www-data", () => {
    const df = generateDockerfile(
      phpConfig({
        runtimeVersion: "8.4",
      }),
    );
    const runtime = runtimeStage(df);

    const userRootIdx = runtime.indexOf("USER root");
    const cleanupIdx = runtime.indexOf("rm -f /tmp/openship-composer");
    const caddyDirIdx = runtime.indexOf("mkdir -p /data/caddy /config/caddy");
    const dropRootIdx = runtime.lastIndexOf("USER www-data");

    expect(userRootIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeGreaterThan(userRootIdx);
    expect(caddyDirIdx).toBeGreaterThan(userRootIdx);
    expect(dropRootIdx).toBeGreaterThan(cleanupIdx);
    expect(dropRootIdx).toBeGreaterThan(caddyDirIdx);
  });

  it("concludes the runtime container with USER www-data and exposes port", () => {
    const df = generateDockerfile(phpConfig({ port: 8080 }));
    const runtime = runtimeStage(df);

    expect(runtime).toContain("USER www-data");
    expect(runtime).toContain("EXPOSE 8080");

    const userWwwDataIdx = runtime.lastIndexOf("USER www-data");
    const exposeIdx = runtime.indexOf("EXPOSE 8080");
    expect(exposeIdx).toBeGreaterThan(userWwwDataIdx);
  });

  it("handles optional JS asset stage without breaking user flow", () => {
    const df = generateDockerfile(
      phpConfig({
        buildCommand: "npm run build",
      }),
    );

    expect(df).toContain("AS builder");
    expect(df).toContain("AS assets");
    expect(df).toContain("AS runtime");

    const builder = builderStage(df);
    const runtime = runtimeStage(df);

    expect(builder).toContain("FROM php:8.4-cli AS builder\nUSER root");
    expect(runtime.trim().startsWith("USER root")).toBe(true);
    expect(runtime).toContain("USER www-data");
  });
});
