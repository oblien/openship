import type { BuildConfig } from "../../types";
import { packageManagerEnsureCommand, nodeBinDirs } from "@repo/core";

import { sq } from "../build-pipeline";
import { cachedRunPrefix } from "./cache";
import { normalizeDockerRootDirectory } from "../docker-paths";

const DOCKER_BUILD_EVENT_PREFIX = "[openship-build]";
/**
 * Project env vars that must never reach the inline `export` prefix on a RUN line.
 *
 * `PATH` is not a preference, it is a correctness gate: the prefix is emitted
 * AFTER the stage-level `ENV PATH` (see nodeBinPathEnvLine), so a project that
 * sets PATH — usually by copying a value out of another platform — silently
 * deletes `node_modules/.bin` from the lookup path and every dependency binary
 * goes back to exit 127. The image already knows its own PATH; a build step has
 * no business restating it. Applies to the JS, static, PHP-asset and
 * workspace-prepare recipes at once, since all four share buildEnvPrefix.
 */
const INLINE_BUILD_ENV_EXCLUDES = new Set(["FORCE_COLOR", "TERM", "PATH"]);

export function formatDockerBuildEvent(
  step: "clone" | "install" | "build",
  status: "running" | "completed" | "skipped",
): string {
  return `${DOCKER_BUILD_EVENT_PREFIX} step=${step} status=${status}`;
}

export function normalizeRelativePath(value?: string): string {
  const normalized = value
    ?.trim()
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized === ".") {
    return "";
  }

  return normalized;
}

export function builderSourceDir(rootDirectory?: string): string {
  const normalized = normalizeDockerRootDirectory(rootDirectory);
  return normalized ? `/workspace/${normalized}` : "/workspace";
}

export function buildEnvPrefix(envVars: BuildConfig["envVars"]): string {
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

export function buildRunCommand(command: string, envPrefix: string): string {
  return `${envPrefix}${command}`;
}

export function runtimeCopyDirectives(config: BuildConfig, sourceDir: string): string[] {
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

export function needsMultiStage(config: BuildConfig): boolean {
  return config.buildImage !== config.runtimeImage;
}

/**
 * `ENV PATH` for one stage, so a command naming a locally-installed binary
 * (`next build`, `next start`) resolves — the failure in openship#623, where a
 * detected `next build` reached `/bin/sh` with nothing on PATH and exited 127.
 *
 * ENV rather than an inline `export` inside the RUN line, because the same PATH is
 * needed by three things an inline export cannot reach: the workspace-prepare step
 * (its own RUN layer, emitted before the source WORKDIR), the container's start
 * command (docker.ts sets `Cmd: ["sh","-c", startCommand]`, which overrides this
 * file's CMD entirely but still inherits the image env), and any `docker exec` an
 * operator runs. One line per stage covers all of them.
 *
 * ENV does not cross a `FROM`, so every stage that runs project code emits its own.
 * Returns null for non-node package managers.
 */
export function nodeBinPathEnvLine(
  packageManager: string | undefined,
  roots: string[],
): string | null {
  const dirs = nodeBinDirs(packageManager, roots);
  return dirs.length > 0 ? `ENV PATH="${dirs.join(":")}:$PATH"` : null;
}

/** The monorepo workspace-prepare RUN line (root `pnpm install` etc.). This is
 *  the FIRST pnpm/yarn invocation in the Dockerfile, so the corepack prelude
 *  must lead it — otherwise the build image (corepack disabled) fails with
 *  "pnpm: not found" before the per-app install line (which has its own prelude)
 *  is ever reached. */
export function workspacePrepareRunLine(
  config: BuildConfig,
  envPrefix: string,
  workspacePrepare: string,
): string {
  const pmEnsure = packageManagerEnsureCommand(config.packageManager);
  const body = pmEnsure ? `${pmEnsure} && ${workspacePrepare}` : workspacePrepare;
  return `${cachedRunPrefix(config)}${envPrefix}${body}`;
}

/**
 * One RUN line covering the requested steps, with the stepper's progress
 * markers. `packageManager` selects the corepack prelude — normally the
 * project's, but the PHP recipe runs its asset build in a Node stage where the
 * project PM ("composer") says nothing about which JS PM the command needs.
 */
export function stepsRunLine(
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
  return steps.length > 0 ? `${cachedRunPrefix(config, opts.packageManager)}${steps.join(" && ")}` : null;
}

/** The install+build RUN line (with progress markers), or null if neither step. */
export function installBuildRunLine(config: BuildConfig, envPrefix: string): string | null {
  return stepsRunLine(config, envPrefix, { install: true, build: true });
}

/** Install step only — the PHP recipe's build step runs in a separate stage. */
export function installRunLine(config: BuildConfig, envPrefix: string): string | null {
  return stepsRunLine(config, envPrefix, { install: true });
}

/** JS package managers a build command can lead with, longest-first so `pnpm`
 *  isn't shadowed by a prefix match. */
const JS_PACKAGE_MANAGERS = ["pnpm", "yarn", "bun", "npm"] as const;

/**
 * Package manager for a Node asset stage, sniffed from the build command itself
 * (`pnpm install && pnpm build` → pnpm) rather than taken from the project's — on
 * the PHP recipe `config.packageManager` is "composer", which says nothing about
 * which JS PM the asset build needs. Falls back to npm: the stage is a Node image
 * running a JS build either way, so its `node_modules/.bin` layout is npm's.
 */
export function assetStagePackageManager(config: BuildConfig): string {
  const command = config.buildCommand?.trim() ?? "";
  return (
    JS_PACKAGE_MANAGERS.find((pm) => new RegExp(`(^|\\s|&&\\s*)${pm}\\s`).test(command)) ?? "npm"
  );
}

/**
 * Build step only, prepared for a Node stage: the corepack prelude is chosen
 * from the command itself rather than from the project's package manager.
 */
export function buildOnlyRunLine(config: BuildConfig, envPrefix: string): string | null {
  const command = config.buildCommand?.trim() ?? "";
  const packageManager = JS_PACKAGE_MANAGERS.find((pm) =>
    new RegExp(`(^|\\s|&&\\s*)${pm}\\s`).test(command),
  );
  return stepsRunLine(config, envPrefix, { build: true, packageManager });
}
