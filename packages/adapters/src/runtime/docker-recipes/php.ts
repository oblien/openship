import { getRuntimeVersionPolicy } from "@repo/core";
import type { BuildConfig } from "../../types";
import { normalizeDockerRootDirectory } from "../docker-paths";
import {
  builderSourceDir,
  normalizeRelativePath,
  buildEnvPrefix,
  installRunLine,
  buildOnlyRunLine,
  nodeBinPathEnvLine,
  assetStagePackageManager,
} from "./shared";

/**
 * PHP extensions installed into BOTH the build and the runtime stage.
 *
 * `pdo_mysql` alone was the old common denominator, which meant a Postgres app
 * simply couldn't connect and a queue worker had no `pcntl`. The set below is
 * what a mainstream Laravel/Symfony app expects; the two stages get the SAME
 * list so `composer install`'s platform check can't pass on a requirement the
 * runtime then lacks.
 *
 * `install-php-extensions` (the same script FrankenPHP bundles) resolves the
 * native build deps for each one — doing this with bare `docker-php-ext-install`
 * would mean hand-maintaining an apt list of `libicu-dev`, `libpq-dev`, … here.
 */
const PHP_EXTENSIONS = [
  "pdo_mysql",
  "pdo_pgsql",
  "redis",
  "pcntl",
  "bcmath",
  "intl",
  "zip",
  "gd",
  // spatie/image + spatie/laravel-medialibrary hard-require ext-exif, so a
  // Laravel app doing image uploads fails `composer install`'s platform check
  // without it. Bundled with PHP but off unless explicitly enabled.
  "exif",
  "opcache",
] as const;

/** Image the builder stage copies `install-php-extensions` from. FrankenPHP has
 *  it built in; the plain `php:*-cli` build image does not. */
const PHP_EXT_INSTALLER_IMAGE = "mlocati/php-extension-installer:2";

/** Build image for the JS asset stage — see `generatePhpDockerfile`. */
const PHP_ASSET_BUILD_IMAGE = "node:22-bookworm-slim";

const PHP_EXT_INSTALL_LINE = `RUN install-php-extensions ${PHP_EXTENSIONS.join(" ")} > /dev/null`;

function phpBinaryVersionCheck(config: BuildConfig): string[] {
  const version =
    config.runtimeVersion ??
    (config.runtimeImageOverride
      ? getRuntimeVersionPolicy(config.stack)?.defaultVersion
      : undefined);
  if (!version) return [];
  return [
    `RUN php -r 'if (PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION !== "${version}") { fwrite(STDERR, "Openship requires PHP ${version}; image provides " . PHP_VERSION . "\\n"); exit(1); }'`,
  ];
}

function phpPlatformCheck(composer: string): string {
  // check-platform-reqs ignores config.platform. Unset the bypass env vars, and
  // disable plugins/scripts: the check must measure the image, not run app code.
  return `RUN if [ -f composer.json ]; then env -u COMPOSER_IGNORE_PLATFORM_REQ -u COMPOSER_IGNORE_PLATFORM_REQS ${composer} check-platform-reqs --no-dev --no-plugins --no-scripts --no-interaction; fi`;
}

/**
 * PHP recipe: Composer in the builder, an optional Node stage for the JS asset
 * pipeline, FrankenPHP as the runtime.
 *
 * Two things drive the shape. First, PHP's install and build steps are DIFFERENT
 * toolchains: `composer install` is the install step, and the build step is the
 * asset pipeline (`npm run build`) that a Laravel/Vite or Symfony/Encore app
 * needs and that a `php:*-cli` image can't run. So the build command, when the
 * detector found one, goes to its own `node:*` stage and only its output — the
 * docroot — is copied forward. Nothing is emitted when there's no asset build.
 *
 * Second, the extension install is the expensive layer, so it sits BEFORE the
 * source copy in both stages: it then caches across every commit, and across
 * every PHP project on the same builder.
 */
export function generatePhpDockerfile(config: BuildConfig): string {
  const sourceDir = builderSourceDir(
    normalizeDockerRootDirectory(config.rootDirectory, config.localPath),
  );
  const envPrefix = buildEnvPrefix(config.envVars);
  const installLine = installRunLine(config, envPrefix);
  const assetBuildLine = buildOnlyRunLine(config, envPrefix);

  const lines: string[] = [
    `FROM ${config.buildImage} AS builder`,
    ...phpBinaryVersionCheck(config),
    // php:*-cli ships no Composer — pull the binary from the official image.
    `COPY --from=composer:2 /usr/bin/composer /usr/bin/composer`,
    `COPY --from=${PHP_EXT_INSTALLER_IMAGE} /usr/bin/install-php-extensions /usr/bin/install-php-extensions`,
    PHP_EXT_INSTALL_LINE,
    `WORKDIR /workspace`,
    `COPY . /workspace`,
    `WORKDIR ${sourceDir}`,
  ];
  if (installLine) lines.push(installLine);
  if (config.runtimeVersion || config.runtimeImageOverride)
    lines.push(phpPlatformCheck("composer"));

  if (assetBuildLine) {
    // The asset stage is a Node image running the JS build, so it needs the same
    // PATH as a JS recipe — keyed off the command's own PM, not the project's.
    const assetBinPath = nodeBinPathEnvLine(assetStagePackageManager(config), [
      sourceDir,
      "/workspace",
    ]);
    lines.push(
      `FROM ${PHP_ASSET_BUILD_IMAGE} AS assets`,
      ...(assetBinPath ? [assetBinPath] : []),
      `WORKDIR /workspace`,
      // Include Composer's installed packages and generated files. Copying the
      // complete workspace also handles custom vendor-dir and monorepo installs.
      `COPY --from=builder /workspace /workspace`,
      `WORKDIR ${sourceDir}`,
      assetBuildLine,
    );
  }

  const docroot = normalizeRelativePath(config.outputDirectory) || "public";

  lines.push(
    `FROM ${config.runtimeImage} AS runtime`,
    ...(config.runtimeImageOverride
      ? [
          "RUN command -v frankenphp >/dev/null && command -v install-php-extensions >/dev/null && id www-data >/dev/null || { printf 'Openship runtime image must provide FrankenPHP, install-php-extensions and www-data\\n' >&2; exit 1; }",
        ]
      : []),
    ...phpBinaryVersionCheck(config),
    PHP_EXT_INSTALL_LINE,
    // --chown on the COPY instead of a trailing `chown -R`: the recursive form
    // rewrites every file into a second layer, doubling the app's size on disk.
    // Ownership has to be settled HERE, before anything mounts: Docker seeds a
    // fresh named volume from the image directory it covers, ownership included,
    // so `/app/storage` is only writable by the runtime user if it was already
    // owned by them in the image (see @repo/core volumes.ts).
    `COPY --from=builder --chown=www-data:www-data ${sourceDir} /app`,
  );
  if (assetBuildLine) {
    lines.push(
      `COPY --from=assets --chown=www-data:www-data ${sourceDir}/${docroot} /app/${docroot}`,
    );
  }
  lines.push(`WORKDIR /app`);
  if (config.runtimeVersion || config.runtimeImageOverride) {
    lines.push(
      `COPY --from=builder /usr/bin/composer /tmp/openship-composer`,
      phpPlatformCheck("php /tmp/openship-composer") + ` && rm -f /tmp/openship-composer`,
    );
  }
  lines.push(
    // FrankenPHP's bundled Caddyfile reads the docroot from SERVER_ROOT (default
    // `public/`, resolved against WORKDIR). Setting it keeps the project's
    // outputDirectory authoritative for BOTH what gets served and where the asset
    // stage's output lands — otherwise a project that renamed its docroot builds
    // assets into one directory and serves another.
    `ENV SERVER_ROOT=${docroot}/`,
    // Caddy's config + data dirs are root-owned in the base image, and it writes
    // to both on startup — without this the non-root switch below fails at boot.
    `RUN mkdir -p /data/caddy /config/caddy && chown -R www-data:www-data /data/caddy /config/caddy`,
    // The frankenphp binary carries cap_net_bind_service, so dropping root here
    // still leaves any port bindable.
    `USER www-data`,
    `EXPOSE ${config.port}`,
  );
  if (config.startCommand) {
    lines.push(`CMD ["sh", "-c", ${JSON.stringify(config.startCommand)}]`);
  }

  return lines.join("\n");
}
