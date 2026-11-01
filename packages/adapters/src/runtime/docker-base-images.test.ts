import { describe, expect, it, vi } from "vitest";
import { pinDockerfileBaseImages } from "./docker-base-images";
import { generateDockerfile } from "./docker-build-plan";
import type { BuildConfig } from "../types";

const digest = `sha256:${"a".repeat(64)}`;
const nextDigest = `sha256:${"b".repeat(64)}`;

describe("Dockerfile base-image receipts", () => {
  it("pins multistage inputs and preserves stage aliases and original tracking references", async () => {
    const resolve = vi.fn(async (ref: string) => (ref === "php:8.4-cli" ? digest : nextDigest));
    const source =
      "FROM php:8.4-cli AS build\nRUN composer install\nFROM build AS verify\nFROM php:8.4-fpm\nCOPY --from=build /app /app\n";
    const result = await pinDockerfileBaseImages(source, resolve);
    expect(result.baseImages).toEqual([
      { ref: "php:8.4-cli", digest },
      { ref: "php:8.4-fpm", digest: nextDigest },
    ]);
    expect(result.dockerfile).toContain(`FROM php:8.4-cli@${digest} AS build`);
    expect(result.dockerfile).toContain("FROM build AS verify");
    expect(result.dockerfile).toContain(`FROM php:8.4-fpm@${nextDigest}`);
    expect(resolve.mock.calls.map(([ref]) => ref)).toEqual(["php:8.4-cli", "php:8.4-fpm"]);
  });

  it("keeps digest pins and scratch exact without querying a mutable tag", async () => {
    const resolve = vi.fn();
    const dockerfile = `FROM php:8.4-fpm@${digest} AS runtime\nFROM scratch\nCOPY --from=runtime /app /app\n`;
    expect(await pinDockerfileBaseImages(dockerfile, resolve)).toEqual({
      dockerfile,
      baseImages: [{ ref: `php:8.4-fpm@${digest}`, digest }],
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("pins only the COPY source flag when its image text also occurs in file paths", async () => {
    const source = "FROM scratch\nCOPY --from=busybox:1 /foo /busybox:1\n";
    const result = await pinDockerfileBaseImages(source, async () => digest);
    expect(result.dockerfile).toBe(
      `FROM scratch\nCOPY --from=busybox:1@${digest} /foo /busybox:1\n`,
    );
    expect(result.baseImages).toEqual([{ ref: "busybox:1", digest }]);
  });

  it.each([
    "ARG PHP_VERSION=8.4\nFROM php:${PHP_VERSION}-fpm\n",
    `FROM php:8.4@${digest}@unexpected\n`,
    "FROM php:8.4-fpm\nRUN <<EOF\nFROM text-inside-heredoc\nEOF\n",
    "FROM alpine:3.20\nCOPY <<\\EOF /recipe.txt\nFROM busybox:1\nEOF\n",
    "FROM alpine:3.20\nCOPY <<'EOF' /recipe.txt\nFROM busybox:1\nEOF\n",
    'FROM alpine:3.20\nCOPY <<"EOF" /recipe.txt\nFROM busybox:1\nEOF\n',
    "FROM --platform=linux/arm64 php:8.4-fpm\n",
    "# syntax=example.com/custom/frontend:1\nFROM php:8.4-fpm\n",
    "FROM php:8.4-fpm\nCOPY --from=${EXTERNAL} /etc/nginx /etc/nginx\n",
    "FROM php:8.4-fpm \\\n AS runtime\n",
  ])("keeps unsupported Dockerfile semantics unchanged and unknown: %s", async (dockerfile) => {
    const resolve = vi.fn();
    expect(await pinDockerfileBaseImages(dockerfile, resolve)).toEqual({ dockerfile });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([undefined, "unknown"])(
    "keeps local-only or unproven bases unknown (%s)",
    async (value) => {
      const dockerfile = "FROM custombase:local\n";
      expect(await pinDockerfileBaseImages(dockerfile, async () => value)).toEqual({ dockerfile });
    },
  );

  it("does not publish a partial receipt or rewrite when registry resolution fails", async () => {
    const dockerfile = "FROM php:8.4-cli AS build\nFROM php:8.4-fpm\n";
    expect(
      await pinDockerfileBaseImages(dockerfile, async (ref) => {
        if (ref.endsWith("-fpm")) throw new Error("registry unavailable");
        return digest;
      }),
    ).toEqual({ dockerfile });
  });

  it("propagates cancellation instead of continuing an unknown build", async () => {
    const abort = new AbortController();
    const reason = new Error("cancelled");
    await expect(
      pinDockerfileBaseImages(
        "FROM php:8.4-fpm",
        async () => {
          abort.abort(reason);
          return digest;
        },
        abort.signal,
      ),
    ).rejects.toBe(reason);
  });

  it.each([
    { stack: "node", buildImage: "node:22", runtimeImage: "node:22" },
    { stack: "bun", buildImage: "oven/bun:1.3.14", runtimeImage: "oven/bun:1.3.14" },
    { stack: "python", buildImage: "python:3.13", runtimeImage: "python:3.13-slim" },
    {
      stack: "ruby",
      buildImage: "ruby:3.4",
      runtimeImage: "ruby:3.4-slim",
      packageManager: "bundler",
    },
    { stack: "go", buildImage: "golang:1.26", runtimeImage: "debian:bookworm-slim" },
    { stack: "rust", buildImage: "rust:1.91", runtimeImage: "debian:bookworm-slim" },
    { stack: "java", buildImage: "eclipse-temurin:21-jdk", runtimeImage: "eclipse-temurin:21-jre" },
    {
      stack: "dotnet",
      buildImage: "mcr.microsoft.com/dotnet/sdk:9.0",
      runtimeImage: "mcr.microsoft.com/dotnet/aspnet:9.0",
    },
    {
      stack: "laravel",
      buildImage: "php:8.4-cli",
      runtimeImage: "dunglas/frankenphp:1-php8.4-bookworm",
      packageManager: "composer",
    },
  ])("records every literal image input in generated $stack recipes", async (fields) => {
    const dockerfile = generateDockerfile({
      installCommand: "echo install",
      buildCommand: "echo build",
      startCommand: "echo start",
      outputDirectory: "public",
      port: 8080,
      envVars: {},
      buildCache: true,
      ...fields,
    } as BuildConfig);
    const result = await pinDockerfileBaseImages(dockerfile, async () => digest);
    expect(result.baseImages?.length).toBeGreaterThan(0);
    expect(result.dockerfile).toContain(`@${digest}`);
    if (fields.stack === "laravel") {
      expect(result.baseImages).toContainEqual({ ref: "composer:2", digest });
      expect(result.dockerfile).toContain(`COPY --from=composer:2@${digest} `);
    }
  });
});
