import type { BuildConfig } from "../types";
import { packageManagerEnsureCommand } from "@repo/core";

import { sq } from "./build-pipeline";
import { normalizeDockerRootDirectory } from "./docker-paths";

const DOCKER_BUILD_EVENT_PREFIX = "[openship-build]";
const INLINE_BUILD_ENV_EXCLUDES = new Set(["FORCE_COLOR", "TERM"]);

function formatDockerBuildEvent(
  step: "clone" | "install" | "build",
  status: "running" | "completed" | "skipped",
): string {
  return `${DOCKER_BUILD_EVENT_PREFIX} step=${step} status=${status}`;
}

function normalizeRelativePath(value?: string): string {
  const normalized = value?.trim().replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized === ".") {
    return "";
  }

  return normalized;
}

function builderSourceDir(rootDirectory?: string): string {
  const normalized = normalizeDockerRootDirectory(rootDirectory);
  return normalized ? `/workspace/${normalized}` : "/workspace";
}

function buildEnvPrefix(envVars: BuildConfig["envVars"]): string {
  const assignments = Object.entries(envVars)
    .filter(([key]) => !INLINE_BUILD_ENV_EXCLUDES.has(key))
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `${key}=${sq(value)}`);

  if (!envVars.NO_COLOR) {
    assignments.push("NO_COLOR='1'");
  }

  if (assignments.length === 0) {
    return "";
  }

  return `export ${assignments.join(" ")} && `;
}

function buildRunCommand(command: string, envPrefix: string): string {
  return `${envPrefix}${command}`;
}

function runtimeCopyDirectives(config: BuildConfig, sourceDir: string): string[] {
  if (config.productionPaths && config.productionPaths.length > 0) {
    return config.productionPaths.map((path) => {
      const normalized = normalizeRelativePath(path);
      const source = normalized ? `${sourceDir}/${normalized}` : sourceDir;
      const target = normalized ? `/app/${normalized}` : "/app";
      return `COPY --from=builder ${source} ${target}`;
    });
  }

  return [`COPY --from=builder ${sourceDir} /app`];
}

function needsMultiStage(config: BuildConfig): boolean {
  return config.buildImage !== config.runtimeImage;
}

/** The monorepo workspace-prepare RUN line (root `pnpm install` etc.). This is
 *  the FIRST pnpm/yarn invocation in the Dockerfile, so the corepack prelude
 *  must lead it — otherwise the build image (corepack disabled) fails with
 *  "pnpm: not found" before the per-app install line (which has its own prelude)
 *  is ever reached. */
function workspacePrepareRunLine(config: BuildConfig, envPrefix: string, workspacePrepare: string): string {
  const pmEnsure = packageManagerEnsureCommand(config.packageManager);
  const body = pmEnsure ? `${pmEnsure} && ${workspacePrepare}` : workspacePrepare;
  return `RUN ${envPrefix}${body}`;
}

/**
 * One RUN line covering the requested steps, with the stepper's progress
 * markers. `packageManager` selects the corepack prelude — normally the
 * project's, but the PHP recipe runs its asset build in a Node stage where the
 * project PM ("composer") says nothing about which JS PM the command needs.
 */
function stepsRunLine(
  config: BuildConfig,
  envPrefix: string,
  opts: { install?: boolean; build?: boolean; packageManager?: string },
): string | null {
  const install = opts.install ? config.installCommand : "";
  const build = opts.build ? config.buildCommand : "";
  const steps: string[] = [];
  // Ensure the package manager exists in the image before install
  // (corepack for pnpm/yarn; no-op for npm/bun/non-node) — fixes "pnpm: not found".
  const pmEnsure = packageManagerEnsureCommand(opts.packageManager ?? config.packageManager);
  if (pmEnsure && (install || build)) {
    steps.push(pmEnsure);
  }
  if (install) {
    steps.push(`printf '${formatDockerBuildEvent("install", "running")}\\n'`);
    steps.push(buildRunCommand(install, envPrefix));
    steps.push(`printf '${formatDockerBuildEvent("install", "completed")}\\n'`);
  }
  if (build) {
    steps.push(`printf '${formatDockerBuildEvent("build", "running")}\\n'`);
    steps.push(buildRunCommand(build, envPrefix));
    steps.push(`printf '${formatDockerBuildEvent("build", "completed")}\\n'`);
  }
  return steps.length > 0 ? `RUN ${steps.join(" && ")}` : null;
}

/** The install+build RUN line (with progress markers), or null if neither step. */
function installBuildRunLine(config: BuildConfig, envPrefix: string): string | null {
  return stepsRunLine(config, envPrefix, { install: true, build: true });
}

/** Install step only — the PHP recipe's build step runs in a separate stage. */
function installRunLine(config: BuildConfig, envPrefix: string): string | null {
  return stepsRunLine(config, envPrefix, { install: true });
}

/** JS package managers a build command can lead with, longest-first so `pnpm`
 *  isn't shadowed by a prefix match. */
const JS_PACKAGE_MANAGERS = ["pnpm", "yarn", "bun", "npm"] as const;

/**
 * Build step only, prepared for a Node stage: the corepack prelude is chosen
 * from the command itself (`pnpm install && pnpm build` → pnpm) rather than from
 * the project's package manager.
 */
function buildOnlyRunLine(config: BuildConfig, envPrefix: string): string | null {
  const command = config.buildCommand?.trim() ?? "";
  const packageManager = JS_PACKAGE_MANAGERS.find((pm) =>
    new RegExp(`(^|\\s|&&\\s*)${pm}\\s`).test(command),
  );
  return stepsRunLine(config, envPrefix, { build: true, packageManager });
}

/** PHP stacks build with the `php:*-cli` image (plus Composer, which it doesn't
 *  ship) and run on FrankenPHP, whose docroot convention — `public/` under
 *  WORKDIR `/app` — is already the layout this recipe emits. The `^php:` arm
 *  keeps a project that pinned a raw php runtime image on this branch rather
 *  than dropping it into the generic single-CMD template, which can't express a
 *  PHP web recipe at all. */
function isPhpRuntime(config: BuildConfig): boolean {
  return /^php:/.test(config.runtimeImage) || /frankenphp/i.test(config.runtimeImage);
}

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
  "opcache",
] as const;

/** Image the builder stage copies `install-php-extensions` from. FrankenPHP has
 *  it built in; the plain `php:*-cli` build image does not. */
const PHP_EXT_INSTALLER_IMAGE = "mlocati/php-extension-installer:2";

/** Build image for the JS asset stage — see `generatePhpDockerfile`. */
const PHP_ASSET_BUILD_IMAGE = "node:22-bookworm-slim";

const PHP_EXT_INSTALL_LINE = `RUN install-php-extensions ${PHP_EXTENSIONS.join(" ")} > /dev/null`;

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
function generatePhpDockerfile(config: BuildConfig): string {
  const sourceDir = builderSourceDir(
    normalizeDockerRootDirectory(config.rootDirectory, config.localPath),
  );
  const envPrefix = buildEnvPrefix(config.envVars);
  const installLine = installRunLine(config, envPrefix);
  const assetBuildLine = buildOnlyRunLine(config, envPrefix);

  const lines: string[] = [
    `FROM ${config.buildImage} AS builder`,
    // php:*-cli ships no Composer — pull the binary from the official image.
    `COPY --from=composer:2 /usr/bin/composer /usr/bin/composer`,
    `COPY --from=${PHP_EXT_INSTALLER_IMAGE} /usr/bin/install-php-extensions /usr/bin/install-php-extensions`,
    PHP_EXT_INSTALL_LINE,
    `WORKDIR /workspace`,
    `COPY . /workspace`,
    `WORKDIR ${sourceDir}`,
  ];
  if (installLine) lines.push(installLine);

  if (assetBuildLine) {
    lines.push(
      `FROM ${PHP_ASSET_BUILD_IMAGE} AS assets`,
      `WORKDIR /workspace`,
      `COPY . /workspace`,
      `WORKDIR ${sourceDir}`,
      assetBuildLine,
    );
  }

  const docroot = normalizeRelativePath(config.outputDirectory) || "public";

  lines.push(
    `FROM ${config.runtimeImage} AS runtime`,
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
  lines.push(
    `WORKDIR /app`,
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

// nginx server block for a static SPA build. `listen` is baked at build time
// (the port is known); nginx's own $uri is written literally.
function staticNginxTemplateLines(port: number): string[] {
  return [
    "server {",
    `    listen ${port} default_server;`,
    "    root /usr/share/nginx/html;",
    "    index index.html;",
    "    location / { try_files $uri $uri/ /index.html; }",
    "}",
  ];
}

/**
 * Where the built files land INSIDE the builder stage.
 *
 * Exported because the extract-only path has to read exactly the directory the
 * recipe wrote. Deriving it twice is how the extractor silently ends up copying an
 * empty or wrong dir when `rootDirectory` / `outputDirectory` handling shifts, so
 * both the Dockerfile and `buildStaticToHost` call this.
 */
export function staticBuilderOutputPath(config: BuildConfig): string {
  const sourceDir = builderSourceDir(
    normalizeDockerRootDirectory(config.rootDirectory, config.localPath),
  );
  const output = normalizeRelativePath(config.outputDirectory);
  return output ? `${sourceDir}/${output}` : sourceDir;
}

/**
 * Static build → served as files by a minimal nginx image with SPA fallback,
 * matching how Vercel serves a static output directory. A builder stage runs the
 * app's install+build (and any monorepo workspace prepare), then the built
 * `outputDirectory` is copied into `nginx:alpine`. No runtime dependency fetch.
 */
function generateStaticDockerfile(config: BuildConfig): string {
  const sourceDir = builderSourceDir(
    normalizeDockerRootDirectory(config.rootDirectory, config.localPath),
  );
  const envPrefix = buildEnvPrefix(config.envVars);
  const workspacePrepare = config.workspacePrepareCommand?.trim();
  const outputPath = staticBuilderOutputPath(config);
  const nginxTemplate = staticNginxTemplateLines(config.port)
    .map((line) => `'${line}'`)
    .join(" ");

  const lines: string[] = [
    `FROM ${config.buildImage} AS builder`,
    `WORKDIR /workspace`,
    `COPY . /workspace`,
  ];
  if (workspacePrepare) {
    lines.push(workspacePrepareRunLine(config, envPrefix, workspacePrepare));
  }
  lines.push(`WORKDIR ${sourceDir}`);
  const stepsLine = installBuildRunLine(config, envPrefix);
  if (stepsLine) lines.push(stepsLine);

  // Extract-only: the caller lifts the built files out and deletes the image, so
  // the recipe STOPS at the builder. No second base image is pulled and nothing is
  // copied twice — the extractor reads `staticBuilderOutputPath(config)` (this same
  // `outputPath`) straight out of the builder. The nginx stage, its six steps, and
  // a server config nothing ever reads were all discarded work on every deploy.
  if (config.staticExtractOnly) return lines.join("\n");

  lines.push(
    `FROM nginx:alpine AS runtime`,
    `RUN rm -f /etc/nginx/conf.d/default.conf`,
    `COPY --from=builder ${outputPath} /usr/share/nginx/html`,
    `RUN printf '%s\\n' ${nginxTemplate} > /etc/nginx/conf.d/app.conf`,
    `EXPOSE ${config.port}`,
    `CMD ["nginx", "-g", "daemon off;"]`,
  );

  return lines.join("\n");
}

export function generateDockerfile(config: BuildConfig): string {
  // Static builds are served as files by a minimal nginx image (SPA fallback).
  if (config.isStatic) {
    return generateStaticDockerfile(config);
  }

  // PHP stacks need a bespoke fpm+nginx recipe (Composer in build, nginx in
  // runtime) that the generic single-CMD template can't express.
  if (isPhpRuntime(config) && needsMultiStage(config)) {
    return generatePhpDockerfile(config);
  }

  const sourceDir = builderSourceDir(
    normalizeDockerRootDirectory(config.rootDirectory, config.localPath),
  );
  const multiStage = needsMultiStage(config);
  const envPrefix = buildEnvPrefix(config.envVars);
  const workspacePrepare = config.workspacePrepareCommand?.trim();

  const lines: string[] = multiStage
    ? [
        `FROM ${config.buildImage} AS builder`,
        `WORKDIR /workspace`,
        `COPY . /workspace`,
      ]
    : [
        `FROM ${config.runtimeImage}`,
        `WORKDIR /workspace`,
        `COPY . /workspace`,
      ];

  // Monorepo workspace prepare: runs ONCE at /workspace (repo root)
  // before we cd into the sub-app and run the per-service install.
  // Any workspace-level prep — install, codegen, schema sync — chained
  // with `&&`. Wraps in its own RUN layer so docker can cache it across
  // sub-app rebuilds (most pushes only touch one sub-app).
  if (workspacePrepare) {
    // envPrefix already ends with ` && ` when non-empty, so no extra
    // separator is needed — adding one would produce a stray double
    // space inside the Dockerfile RUN line.
    lines.push(workspacePrepareRunLine(config, envPrefix, workspacePrepare));
  }

  lines.push(`WORKDIR ${sourceDir}`);

  // Single RUN for install+build - avoids costly Docker layer commits between steps.
  // Each step emits markers so the UI stepper can track progress.
  const stepsLine = installBuildRunLine(config, envPrefix);
  if (stepsLine) {
    lines.push(stepsLine);
  }

  if (multiStage) {
    lines.push(`FROM ${config.runtimeImage} AS runtime`);
    lines.push(...runtimeCopyDirectives(config, sourceDir));
    lines.push(`WORKDIR /app`);
  }
  lines.push(`EXPOSE ${config.port}`);
  if (config.startCommand) {
    lines.push(`CMD ["sh", "-c", ${JSON.stringify(config.startCommand)}]`);
  }

  return lines.join("\n");
}