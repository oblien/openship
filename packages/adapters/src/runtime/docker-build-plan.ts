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

/** The install+build RUN line (with progress markers), or null if neither step. */
function installBuildRunLine(config: BuildConfig, envPrefix: string): string | null {
  const steps: string[] = [];
  // Ensure the package manager exists in the builder image before install
  // (corepack for pnpm/yarn; no-op for npm/bun/non-node) — fixes "pnpm: not found".
  const pmEnsure = packageManagerEnsureCommand(config.packageManager);
  if (pmEnsure && (config.installCommand || config.buildCommand)) {
    steps.push(pmEnsure);
  }
  if (config.installCommand) {
    steps.push(`printf '${formatDockerBuildEvent("install", "running")}\\n'`);
    steps.push(buildRunCommand(config.installCommand, envPrefix));
    steps.push(`printf '${formatDockerBuildEvent("install", "completed")}\\n'`);
  }
  if (config.buildCommand) {
    steps.push(`printf '${formatDockerBuildEvent("build", "running")}\\n'`);
    steps.push(buildRunCommand(config.buildCommand, envPrefix));
    steps.push(`printf '${formatDockerBuildEvent("build", "completed")}\\n'`);
  }
  return steps.length > 0 ? `RUN ${steps.join(" && ")}` : null;
}

/** PHP stacks are served php-fpm + nginx. The php:*-cli build image has no
 *  Composer and the php:*-fpm runtime image has no web server, so both are added
 *  here; the launch itself (envsubst + php-fpm + nginx) is the stack's start
 *  command, because the runtime overrides the image CMD at `docker run`. */
function isPhpRuntime(config: BuildConfig): boolean {
  return /^php:/.test(config.runtimeImage);
}

// nginx server block for a public/-docroot PHP app. `${PORT}` is substituted at
// start time by envsubst; nginx's own $uri/$document_root/etc. are written
// literally (single-quoted at build time) so envsubst leaves them intact.
const PHP_NGINX_TEMPLATE_LINES = [
  "server {",
  "    listen ${PORT} default_server;",
  "    root /app/public;",
  "    index index.php index.html;",
  "    location / { try_files $uri $uri/ /index.php?$query_string; }",
  "    location ~ \\.php$ {",
  "        fastcgi_pass 127.0.0.1:9000;",
  "        fastcgi_index index.php;",
  "        include fastcgi_params;",
  "        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;",
  "    }",
  "}",
];

function generatePhpDockerfile(config: BuildConfig): string {
  const sourceDir = builderSourceDir(
    normalizeDockerRootDirectory(config.rootDirectory, config.localPath),
  );
  const envPrefix = buildEnvPrefix(config.envVars);
  const stepsLine = installBuildRunLine(config, envPrefix);
  const nginxTemplate = PHP_NGINX_TEMPLATE_LINES.map((line) => `'${line}'`).join(" ");

  const lines: string[] = [
    `FROM ${config.buildImage} AS builder`,
    `WORKDIR /workspace`,
    `COPY . /workspace`,
    // php:*-cli ships no Composer — pull the binary from the official image.
    `COPY --from=composer:2 /usr/bin/composer /usr/bin/composer`,
    // pdo_mysql is the common denominator (Laravel/Symfony + MySQL/MariaDB);
    // app-specific extensions are a per-project follow-on.
    `RUN docker-php-ext-install pdo_mysql > /dev/null`,
    `WORKDIR ${sourceDir}`,
  ];
  if (stepsLine) lines.push(stepsLine);

  lines.push(
    `FROM ${config.runtimeImage} AS runtime`,
    `RUN apt-get update && apt-get install -y --no-install-recommends nginx gettext-base && rm -rf /var/lib/apt/lists/* && rm -f /etc/nginx/sites-enabled/default && docker-php-ext-install pdo_mysql > /dev/null`,
    `COPY --from=builder ${sourceDir} /app`,
    `WORKDIR /app`,
    `RUN printf '%s\\n' ${nginxTemplate} > /etc/nginx/app.conf.template`,
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