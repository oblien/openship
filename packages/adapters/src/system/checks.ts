/**
 * Component health checks — detect installed binaries and running services.
 *
 * All checks run through a CommandExecutor, so they work both locally
 * and on remote servers via SSH. Checks are fast, non-destructive, and
 * safe to run repeatedly.
 *
 * In normal operation, checks run ONCE during setup — the result is
 * cached in SetupStateStore. Subsequent operations read cached state
 * instead of re-running checks (see setup.ts).
 */

import type { CommandExecutor } from "../types";
import type { ComponentStatus } from "./types";
import { systemCatalog } from "./catalog";
import { getSystemComponentDefinition, SYSTEM_COMPONENTS } from "./components";
import { formatDuration, systemDebug } from "./debug";
import { isRemoteConnectionError } from "./errors";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Run a command via executor, return stdout or null on failure. */
async function tryExec(
  executor: CommandExecutor,
  command: string,
): Promise<string | null> {
  const startedAt = Date.now();
  systemDebug("checks", `exec:start ${command}`);
  try {
    const result = await executor.exec(command, { timeout: 10_000 });
    systemDebug(
      "checks",
      `exec:ok ${command} (${formatDuration(startedAt)})`,
    );
    return result;
  } catch (err) {
    if (isRemoteConnectionError(err)) {
      systemDebug(
        "checks",
        `exec:abort ${command} (${formatDuration(startedAt)}) ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    systemDebug(
      "checks",
      `exec:fail ${command} (${formatDuration(startedAt)}) ${msg}`,
    );
    return null;
  }
}

function healthy(
  name: string,
  version: string,
  running?: boolean,
): ComponentStatus {
  const component = getSystemComponentDefinition(name);
  return {
    name,
    label: component.label,
    description: component.description,
    installable: component.installable,
    installed: true,
    version,
    running,
    healthy: running !== undefined ? running : true,
    message: running
      ? `${name} ${version} — running`
      : `${name} ${version} — installed`,
  };
}

function unhealthy(
  name: string,
  message: string,
  opts?: { version?: string; running?: boolean },
): ComponentStatus {
  const component = getSystemComponentDefinition(name);
  return {
    name,
    label: component.label,
    description: component.description,
    installable: component.installable,
    installed: !!opts?.version,
    version: opts?.version,
    running: opts?.running,
    healthy: false,
    message,
  };
}

// ─── Individual checks ──────────────────────────────────────────────────────

export async function checkDocker(
  executor: CommandExecutor,
): Promise<ComponentStatus> {
  const startedAt = Date.now();
  const recipe = systemCatalog.checks.docker;
  const version = await tryExec(executor, recipe.versionCommand);
  if (!version) {
    systemDebug("checks", `docker:missing (${formatDuration(startedAt)})`);
    return unhealthy("docker", recipe.missingMessage);
  }

  const parsed = recipe.parseVersion(version);

  const info = await tryExec(executor, recipe.daemonCommand!);
  if (!info) {
    systemDebug("checks", `docker:not-running (${formatDuration(startedAt)})`);
    return unhealthy("docker", recipe.notRunningMessage!, {
      version: parsed,
      running: false,
    });
  }

  systemDebug("checks", `docker:healthy (${formatDuration(startedAt)})`);
  return healthy("docker", parsed, true);
}

export async function checkTraefik(
  executor: CommandExecutor,
): Promise<ComponentStatus> {
  const startedAt = Date.now();
  const recipe = systemCatalog.checks.traefik;
  const version = await tryExec(executor, recipe.versionCommand);

  let parsed: string | undefined;
  if (version) {
    parsed = recipe.parseVersion(version);
  }

  const runningChecks = await Promise.all(
    recipe.runningCommands!.map((command) => tryExec(executor, command)),
  );
  const running = runningChecks.some(Boolean);

  if (!parsed && !running) {
    systemDebug("checks", `traefik:missing (${formatDuration(startedAt)})`);
    return unhealthy("traefik", recipe.missingMessage);
  }

  if (!running) {
    systemDebug("checks", `traefik:not-running (${formatDuration(startedAt)})`);
    return unhealthy("traefik", recipe.notRunningMessage!, {
      version: parsed,
      running: false,
    });
  }

  systemDebug("checks", `traefik:healthy (${formatDuration(startedAt)})`);
  return healthy("traefik", parsed ?? "unknown", true);
}

export async function checkGit(
  executor: CommandExecutor,
): Promise<ComponentStatus> {
  const startedAt = Date.now();
  const recipe = systemCatalog.checks.git;
  const version = await tryExec(executor, recipe.versionCommand);
  if (!version) {
    systemDebug("checks", `git:missing (${formatDuration(startedAt)})`);
    return unhealthy("git", recipe.missingMessage);
  }
  const parsed = recipe.parseVersion(version);
  systemDebug("checks", `git:healthy (${formatDuration(startedAt)})`);
  return healthy("git", parsed);
}

export async function checkNode(
  executor: CommandExecutor,
): Promise<ComponentStatus> {
  const startedAt = Date.now();
  const recipe = systemCatalog.checks.node;
  const version = await tryExec(executor, recipe.versionCommand);
  if (!version) {
    systemDebug("checks", `node:missing (${formatDuration(startedAt)})`);
    return unhealthy("node", recipe.missingMessage);
  }
  systemDebug("checks", `node:healthy (${formatDuration(startedAt)})`);
  return healthy("node", recipe.parseVersion(version));
}

// ─── Registry ────────────────────────────────────────────────────────────────

type CheckFn = (executor: CommandExecutor) => Promise<ComponentStatus>;

export const COMPONENT_CHECKS: Record<string, CheckFn> = {
  docker: checkDocker,
  traefik: checkTraefik,
  git: checkGit,
  node: checkNode,
};

/** Run every registered check in parallel. */
export async function checkAll(
  executor: CommandExecutor,
): Promise<ComponentStatus[]> {
  const startedAt = Date.now();
  const entries = SYSTEM_COMPONENTS
    .map((component) => [component.name, COMPONENT_CHECKS[component.name]] as const)
    .filter((entry): entry is readonly [string, CheckFn] => Boolean(entry[1]));
  systemDebug(
    "checks",
    `checkAll:start [${entries.map(([name]) => name).join(", ")}]`,
  );
  const result = await Promise.all(entries.map(([, fn]) => fn(executor)));
  systemDebug("checks", `checkAll:done (${formatDuration(startedAt)})`);
  return result;
}

/** Run checks for a specific set of components. */
export async function checkComponents(
  executor: CommandExecutor,
  names: string[],
): Promise<ComponentStatus[]> {
  const startedAt = Date.now();
  const fns = names
    .map((name) => COMPONENT_CHECKS[name])
    .filter(Boolean);
  systemDebug("checks", `checkComponents:start [${names.join(", ")}]`);
  const result = await Promise.all(fns.map((fn) => fn(executor)));
  systemDebug(
    "checks",
    `checkComponents:done [${names.join(", ")}] (${formatDuration(startedAt)})`,
  );
  return result;
}
