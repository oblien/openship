import { describe, expect, it } from "vitest";

import { generateDockerfile } from "../src/runtime/docker-build-plan";
import type { BuildConfig } from "../src/types";

function railsConfig(overrides: Partial<BuildConfig> = {}): BuildConfig {
  return {
    sessionId: "s1",
    projectId: "p1",
    repoUrl: "https://github.com/example/app.git",
    branch: "main",
    stack: "rails",
    buildImage: "ruby:3.3-slim",
    runtimeImage: "ruby:3.3-slim",
    packageManager: "bundler",
    installCommand: "bundle install",
    buildCommand:
      "RAILS_ENV=production SECRET_KEY_BASE_DUMMY=1 bundle exec rails assets:precompile",
    startCommand: 'bundle exec rails server -b 0.0.0.0 -p "${PORT:-3000}"',
    outputDirectory: ".",
    port: 3000,
    envVars: {},
    ...overrides,
  } as BuildConfig;
}

/** Everything after the runtime stage header. */
function runtimeStage(dockerfile: string): string {
  return dockerfile.split("AS runtime")[1] ?? "";
}

function builderStage(dockerfile: string): string {
  return dockerfile.split("AS runtime")[0] ?? "";
}

describe("generateDockerfile — Ruby recipe", () => {
  it("fires even though buildImage === runtimeImage", () => {
    // needsMultiStage() is false for Ruby, so gating on it would skip this
    // recipe entirely the way the PHP branch is gated.
    const df = generateDockerfile(railsConfig());
    expect(df).toContain("AS builder");
    expect(df).toContain("AS runtime");
  });

  it("installs a compiler in the builder — slim images ship none", () => {
    const builder = builderStage(generateDockerfile(railsConfig()));
    expect(builder).toContain("build-essential");
    expect(builder).toContain("libpq-dev");
    expect(builder).toContain("libyaml-dev");
    expect(builder).toContain("pkg-config");
  });

  it("does not carry the compiler into the runtime stage", () => {
    const runtime = runtimeStage(generateDockerfile(railsConfig()));
    expect(runtime).not.toContain("build-essential");
    expect(runtime).not.toContain("libpq-dev");
    // The shared libs the compiled gems link against still have to be there.
    expect(runtime).toContain("libpq5");
  });

  it("excludes dev/test gems from the installed bundle", () => {
    const df = generateDockerfile(railsConfig());
    expect(df).toContain("BUNDLE_WITHOUT=development:test");
    expect(df).toContain("BUNDLE_DEPLOYMENT=1");
  });

  it("copies the resolved bundle forward so runtime does not re-install", () => {
    // Bundler installs to BUNDLE_PATH, outside the app dir, so copying the
    // source across is not enough.
    expect(generateDockerfile(railsConfig())).toContain(
      "COPY --from=builder /usr/local/bundle /usr/local/bundle",
    );
  });

  it("declares the same BUNDLE_* settings in both stages", () => {
    const df = generateDockerfile(railsConfig());
    expect(builderStage(df)).toContain("BUNDLE_PATH=/usr/local/bundle");
    expect(runtimeStage(df)).toContain("BUNDLE_PATH=/usr/local/bundle");
  });

  it("runs the app in production", () => {
    // Development Rails rejects the deployed hostname outright via config.hosts.
    const runtime = runtimeStage(generateDockerfile(railsConfig()));
    expect(runtime).toContain("RAILS_ENV=production");
    expect(runtime).toContain("RAILS_LOG_TO_STDOUT=1");
    expect(runtime).toContain("RAILS_SERVE_STATIC_FILES=1");
  });

  it("drops root", () => {
    expect(generateDockerfile(railsConfig())).toContain("USER rails");
  });

  it("keeps the port and start command", () => {
    const df = generateDockerfile(railsConfig());
    expect(df).toContain("EXPOSE 3000");
    expect(df).toContain("rails server");
  });

  it("puts the apt layer before the source copy so it caches", () => {
    const builder = builderStage(generateDockerfile(railsConfig()));
    expect(builder.indexOf("build-essential")).toBeLessThan(builder.indexOf("COPY . /workspace"));
  });

  it("leaves a non-Ruby stack on the generic template", () => {
    const df = generateDockerfile(
      railsConfig({
        stack: "express",
        buildImage: "node:22",
        runtimeImage: "node:22",
        packageManager: "npm",
        installCommand: "npm ci",
        buildCommand: "",
        startCommand: "node index.js",
      }),
    );
    expect(df).not.toContain("BUNDLE_WITHOUT");
    expect(df).toContain("FROM node:22");
  });
});
