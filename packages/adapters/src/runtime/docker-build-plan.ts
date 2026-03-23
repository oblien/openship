import type { BuildConfig } from "../types";

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

export function generateDockerfile(config: BuildConfig): string {
  const sourceDir = builderSourceDir(
    normalizeDockerRootDirectory(config.rootDirectory, config.localPath),
  );
  const multiStage = needsMultiStage(config);
  const envPrefix = buildEnvPrefix(config.envVars);

  const lines: string[] = multiStage
    ? [
        `FROM ${config.buildImage} AS builder`,
        `WORKDIR /workspace`,
        `COPY . /workspace`,
        `WORKDIR ${sourceDir}`,
      ]
    : [
        `FROM ${config.runtimeImage}`,
        `WORKDIR /workspace`,
        `COPY . /workspace`,
        `WORKDIR ${sourceDir}`,
      ];

  // Single RUN for install+build — avoids costly Docker layer commits between steps.
  // Each step emits markers so the UI stepper can track progress.
  const steps: string[] = [];

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

  if (steps.length > 0) {
    lines.push(`RUN ${steps.join(" && ")}`);
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