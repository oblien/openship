import { describe, it, expect } from "vitest";
import { generateDockerfile } from "./docker-build-plan";
import type { BuildConfig } from "../types";

// generateDockerfile reads only a handful of fields; a partial cast keeps the
// fixtures readable (same pattern as deploy-pipeline.test.ts).
function config(over: Partial<BuildConfig>): BuildConfig {
  return {
    buildImage: "node:22",
    runtimeImage: "node:22",
    installCommand: "",
    buildCommand: "",
    startCommand: "node index.js",
    port: 3000,
    stack: "node",
    envVars: {},
    ...over,
  } as unknown as BuildConfig;
}

const PHP_START = 'SERVER_NAME=":$PORT" exec frankenphp run --config /etc/frankenphp/Caddyfile';

function phpConfig(over: Partial<BuildConfig> = {}): BuildConfig {
  return config({
    buildImage: "php:8.4-cli",
    runtimeImage: "dunglas/frankenphp:1-php8.4-bookworm",
    installCommand: "composer install --no-dev --optimize-autoloader",
    outputDirectory: "public",
    startCommand: PHP_START,
    port: 8000,
    stack: "laravel",
    packageManager: "composer",
    ...over,
  });
}

describe("generateDockerfile — PHP branch", () => {
  const df = generateDockerfile(phpConfig());

  it("builds on php-cli with Composer pulled in", () => {
    expect(df).toContain("FROM php:8.4-cli AS builder");
    expect(df).toContain("COPY --from=composer:2 /usr/bin/composer /usr/bin/composer");
    expect(df).toContain("composer install --no-dev --optimize-autoloader");
  });

  it("installs the same extension set in BOTH stages, not just pdo_mysql", () => {
    const installs = df.match(/RUN install-php-extensions [^\n]+/g) ?? [];
    expect(installs).toHaveLength(2);
    expect(installs[0]).toBe(installs[1]);
    for (const ext of ["pdo_pgsql", "pdo_mysql", "redis", "pcntl", "intl", "gd", "opcache"]) {
      expect(installs[0]).toContain(ext);
    }
  });

  it("caches the extension layer by installing it before the source copy", () => {
    const lines = df.split("\n");
    const extIdx = lines.findIndex((l) => l.startsWith("RUN install-php-extensions"));
    const copyIdx = lines.findIndex((l) => l === "COPY . /workspace");
    expect(extIdx).toBeGreaterThan(-1);
    expect(extIdx).toBeLessThan(copyIdx);
  });

  it("runs on FrankenPHP as a non-root user with Caddy's dirs made writable", () => {
    expect(df).toContain("FROM dunglas/frankenphp:1-php8.4-bookworm AS runtime");
    expect(df).toContain("COPY --from=builder --chown=www-data:www-data /workspace /app");
    expect(df).toContain("chown -R www-data:www-data /data/caddy /config/caddy");
    expect(df).toContain("USER www-data");
  });

  it("serves the project's output directory as the docroot", () => {
    expect(df).toContain("ENV SERVER_ROOT=public/");
    const renamed = generateDockerfile(
      phpConfig({ outputDirectory: "web", buildCommand: "npm i --force && npm run build" }),
    );
    expect(renamed).toContain("ENV SERVER_ROOT=web/");
    expect(renamed).toContain("COPY --from=assets --chown=www-data:www-data /workspace/web /app/web");
  });

  it("drops the fpm+nginx machinery entirely", () => {
    expect(df).not.toContain("nginx");
    expect(df).not.toContain("php-fpm");
    expect(df).not.toContain("envsubst");
    expect(df).not.toContain("fastcgi_pass");
    expect(df).not.toContain("docker-php-ext-install");
  });

  it("launches frankenphp via exec so SIGTERM reaches it, not a dev server", () => {
    expect(df).toContain(`CMD ["sh", "-c", ${JSON.stringify(PHP_START)}]`);
    expect(df).not.toContain("php artisan serve");
  });

  it("emits no asset stage when the project has no JS build", () => {
    expect(df).not.toContain("AS assets");
    expect(df).not.toContain("node:22-bookworm-slim");
  });
});

describe("generateDockerfile — PHP with a JS asset pipeline", () => {
  const df = generateDockerfile(phpConfig({ buildCommand: "npm i --force && npm run build" }));

  it("compiles assets in a Node stage (php:*-cli has no node) and copies the docroot forward", () => {
    expect(df).toContain("FROM node:22-bookworm-slim AS assets");
    expect(df).toContain("npm run build");
    expect(df).toContain(
      "COPY --from=assets --chown=www-data:www-data /workspace/public /app/public",
    );
  });

  it("keeps composer out of the asset stage and the asset build out of the composer stage", () => {
    const assetsStage = df.slice(df.indexOf("AS assets"), df.indexOf("AS runtime"));
    expect(assetsStage).not.toContain("composer");
    const builderStage = df.slice(df.indexOf("AS builder"), df.indexOf("AS assets"));
    expect(builderStage).not.toContain("npm run build");
  });

  it("preludes corepack for a non-npm package manager in the asset stage", () => {
    const pnpm = generateDockerfile(phpConfig({ buildCommand: "pnpm install && pnpm build" }));
    // The project PM is `composer`, so the prelude has to come from the command.
    expect(pnpm).toContain("corepack enable pnpm");
  });
});

describe("generateDockerfile — non-PHP is unaffected", () => {
  it("a same-image Node build stays single-stage with no nginx", () => {
    const df = generateDockerfile(config({ buildImage: "node:22", runtimeImage: "node:22" }));
    expect(df).toContain("FROM node:22");
    expect(df).not.toContain("nginx");
    expect(df).not.toContain("AS builder"); // single stage
  });

  it("still runs install and build in one RUN layer", () => {
    const df = generateDockerfile(
      config({
        buildImage: "node:22",
        runtimeImage: "node:22-slim",
        installCommand: "npm i --force",
        buildCommand: "npm run build",
      }),
    );
    const runLines = df.split("\n").filter((l) => l.startsWith("RUN "));
    expect(runLines).toHaveLength(1);
    expect(runLines[0]).toContain("npm i --force");
    expect(runLines[0]).toContain("npm run build");
  });
});
