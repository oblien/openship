import type { BuildConfig } from "../../types";
import { managedRuntimeImage, packageManagerEnsureCommand, nodeBinDirs } from "@repo/core";

import { buildEnvMount, BUILD_ENV_SOURCE } from "../docker-build-secrets";
import { cachedRunPrefix } from "./cache";
import { normalizeDockerRootDirectory } from "../docker-paths";

const DOCKER_BUILD_EVENT_PREFIX = "[openship-build]";
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

/** Bun is both runtime and package manager, so its explicit runtime selection
 * also selects the build tool. Node's version must not become npm/pnpm's version. */
function ensurePackageManager(config: BuildConfig, manager = config.packageManager): string {
  const image =
    config.runtimeImageOverride && manager === "bun"
      ? managedRuntimeImage(config.runtimeImage)
      : null;
  return packageManagerEnsureCommand(
    manager,
    image?.runtime === "bun" ? image.version ?? undefined : undefined,
  );
}

/** The workspace install runs before per-app commands and needs the same toolchain. */
export function workspacePrepareRunLine(
  config: BuildConfig,
  workspacePrepare: string,
): string {
  const pmEnsure = ensurePackageManager(config);
  const body = pmEnsure ? `${pmEnsure} && ${workspacePrepare}` : workspacePrepare;
  return `${cachedRunPrefix(config)}${buildEnvMount(config)}${BUILD_ENV_SOURCE}${body}`;
}

/**
 * One RUN line covering the requested steps, with the stepper's progress
 * markers. `packageManager` selects the corepack prelude — normally the
 * project's, but the PHP recipe runs its asset build in a Node stage where the
 * project PM ("composer") says nothing about which JS PM the command needs.
 */
export function stepsRunLine(
  config: BuildConfig,
  opts: { install?: boolean; build?: boolean; packageManager?: string },
): string | null {
  const install = opts.install ? config.installCommand : "";
  const build = opts.build ? config.buildCommand : "";
  const steps: string[] = [];
  // Select and verify the package manager before running project commands.
  const pmEnsure = ensurePackageManager(config, opts.packageManager ?? config.packageManager);
  if (pmEnsure && (install || build)) {
    steps.push(pmEnsure);
  }
  if (install) {
    steps.push(`printf '${formatDockerBuildEvent("install", "running")}\\n'`);
    steps.push(`${BUILD_ENV_SOURCE}${install}`);
    steps.push(`printf '${formatDockerBuildEvent("install", "completed")}\\n'`);
  }
  if (build) {
    steps.push(`printf '${formatDockerBuildEvent("build", "running")}\\n'`);
    steps.push(`${BUILD_ENV_SOURCE}${build}`);
    steps.push(`printf '${formatDockerBuildEvent("build", "completed")}\\n'`);
  }
  return steps.length > 0 ? `${cachedRunPrefix(config, opts.packageManager)}${buildEnvMount(config)}${steps.join(" && ")}` : null;
}

/** The install+build RUN line (with progress markers), or null if neither step. */
export function installBuildRunLine(config: BuildConfig): string | null {
  return stepsRunLine(config, { install: true, build: true });
}

/** Install step only — the PHP recipe's build step runs in a separate stage. */
export function installRunLine(config: BuildConfig): string | null {
  return stepsRunLine(config, { install: true });
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
export function buildOnlyRunLine(config: BuildConfig): string | null {
  const command = config.buildCommand?.trim() ?? "";
  const packageManager = JS_PACKAGE_MANAGERS.find((pm) =>
    new RegExp(`(^|\\s|&&\\s*)${pm}\\s`).test(command),
  );
  return stepsRunLine(config, { build: true, packageManager });
}
