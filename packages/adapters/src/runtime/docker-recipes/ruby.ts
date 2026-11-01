import { builderCompatibilityLines, runtimeCompatibilityLines } from "./compatibility";
import type { BuildConfig } from "../../types";
import { normalizeDockerRootDirectory } from "../docker-paths";
import {
  builderSourceDir,
  buildEnvPrefix,
  workspacePrepareRunLine,
  installBuildRunLine,
  runtimeCopyDirectives,
} from "./shared";

/** Builder-only. `ruby:*-slim` installs gcc/make to compile Ruby and then
 *  purges them, so `bundle install` hits the first native gem (`pg`, `bootsnap`)
 *  with no compiler. This is the set Rails' own Dockerfile installs. */
const RUBY_BUILD_PACKAGES = [
  "build-essential",
  "git",
  "pkg-config",
  "libpq-dev",
  "libyaml-dev",
  "libffi-dev",
  "libsqlite3-dev",
] as const;

/** Shared libs the compiled gems link against at runtime; the `-dev` headers
 *  stay in the builder. libvips is here because Active Storage shells out to it,
 *  and a missing one surfaces on first image upload rather than at boot. */
const RUBY_RUNTIME_PACKAGES = ["libpq5", "libyaml-0-2", "libsqlite3-0", "libvips", "curl"] as const;

function rubyPackagesRunLine(stage: "build" | "runtime"): string {
  const debian = stage === "build" ? RUBY_BUILD_PACKAGES : RUBY_RUNTIME_PACKAGES;
  const alpine =
    stage === "build"
      ? "build-base git pkgconf postgresql-dev yaml-dev libffi-dev sqlite-dev"
      : "libpq yaml sqlite-libs vips curl";
  // A configured official ruby:* tag may use Alpine rather than Debian. Select
  // against the stage's actual OS, independently for the builder and runtime.
  return (
    `RUN if [ -f /etc/alpine-release ]; then apk add --no-cache ${alpine}; ` +
    `else apt-get update -qq && apt-get install --no-install-recommends -y ${debian.join(" ")} ` +
    `&& rm -rf /var/lib/apt/lists/*; fi`
  );
}

/**
 * Ruby recipe: a builder with the toolchain, a runtime with only shared libs.
 *
 * Emits its own two stages rather than using the generic multi-stage path —
 * `needsMultiStage` is false here (one image for both), but the whole point is
 * that the stages need different apt sets from that same base.
 *
 * Bundler installs to BUNDLE_PATH, outside the app dir, so the gems are a
 * separate COPY. Both stages declare the same BUNDLE_* values: a runtime whose
 * BUNDLE_WITHOUT disagreed would make `bundle exec` re-resolve and fail.
 */
export function generateRubyDockerfile(config: BuildConfig): string {
  const sourceDir = builderSourceDir(
    normalizeDockerRootDirectory(config.rootDirectory, config.localPath),
  );
  const envPrefix = buildEnvPrefix(config.envVars);
  const workspacePrepare = config.workspacePrepareCommand?.trim();

  // Deployment mode makes the lockfile authoritative instead of silently
  // re-resolving what dev tested against.
  const bundleEnv =
    "ENV BUNDLE_PATH=/usr/local/bundle BUNDLE_WITHOUT=development:test BUNDLE_DEPLOYMENT=1";

  // apt before the source copy, so the layer caches across every commit.
  const lines: string[] = [
    `FROM ${config.buildImage} AS builder`,
    bundleEnv,
    `ENV RAILS_ENV=production RACK_ENV=production`,
    rubyPackagesRunLine("build"),
    `WORKDIR /workspace`,
    `COPY . /workspace`,
  ];

  if (workspacePrepare) {
    lines.push(workspacePrepareRunLine(config, envPrefix, workspacePrepare));
  }

  lines.push(`WORKDIR ${sourceDir}`);

  const stepsLine = installBuildRunLine(config, envPrefix);
  if (stepsLine) {
    lines.push(stepsLine);
  }

  lines.push(...builderCompatibilityLines(config));
  lines.push(
    `FROM ${config.runtimeImage} AS runtime`,
    bundleEnv,
    // Development is the default RAILS_ENV, and a development Rails rejects the
    // deployed hostname via config.hosts. Static serving is on because the edge
    // proxies to the app; nothing else serves public/assets.
    `ENV RAILS_ENV=production RACK_ENV=production RAILS_LOG_TO_STDOUT=1 RAILS_SERVE_STATIC_FILES=1`,
    rubyPackagesRunLine("runtime"),
    ...runtimeCompatibilityLines(config),
    `COPY --from=builder /usr/local/bundle /usr/local/bundle`,
    ...runtimeCopyDirectives(config, sourceDir),
    `WORKDIR /app`,
    // tmp/ and log/ are written per request; storage/ is the declared volume,
    // chowned so the mount is writable when Docker creates it.
    `RUN if [ -f /etc/alpine-release ]; then addgroup -S -g 1000 rails ` +
      `&& adduser -S -u 1000 -G rails -h /home/rails rails; ` +
      `else groupadd --system --gid 1000 rails ` +
      `&& useradd --system --uid 1000 --gid 1000 --create-home --shell /bin/bash rails; fi ` +
      `&& mkdir -p tmp log storage && chown -R rails:rails /app`,
    `USER rails`,
    `EXPOSE ${config.port}`,
  );

  if (config.startCommand) {
    lines.push(`CMD ["sh", "-c", ${JSON.stringify(config.startCommand)}]`);
  }

  return lines.join("\n");
}
