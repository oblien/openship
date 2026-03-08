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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Run a command via executor, return stdout or null on failure. */
async function tryExec(
  executor: CommandExecutor,
  command: string,
): Promise<string | null> {
  try {
    return await executor.exec(command, { timeout: 10_000 });
  } catch {
    return null;
  }
}

function healthy(
  name: string,
  version: string,
  running?: boolean,
): ComponentStatus {
  return {
    name,
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
  return {
    name,
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
  const version = await tryExec(executor, "docker --version");
  if (!version) {
    return unhealthy("docker", "Docker is not installed");
  }

  const parsed = version.match(/Docker version ([^\s,]+)/)?.[1] ?? version;

  const info = await tryExec(
    executor,
    "docker info --format '{{.ServerVersion}}'",
  );
  if (!info) {
    return unhealthy("docker", "Docker is installed but the daemon is not running", {
      version: parsed,
      running: false,
    });
  }

  return healthy("docker", parsed, true);
}

export async function checkTraefik(
  executor: CommandExecutor,
): Promise<ComponentStatus> {
  const version = await tryExec(
    executor,
    "traefik version --format json 2>/dev/null",
  );

  let parsed: string | undefined;
  if (version) {
    try {
      parsed = JSON.parse(version).Version;
    } catch {
      parsed = version.match(/Version:\s*(\S+)/)?.[1] ?? version;
    }
  }

  // Check for running process — either native or Docker container
  const process = await tryExec(executor, "pgrep -x traefik");
  const dockerContainer = await tryExec(
    executor,
    "docker ps --filter name=traefik --format '{{.Names}}' 2>/dev/null",
  );

  const running = !!process || !!dockerContainer;

  if (!parsed && !running) {
    return unhealthy("traefik", "Traefik is not installed");
  }

  if (!running) {
    return unhealthy("traefik", "Traefik is installed but not running", {
      version: parsed,
      running: false,
    });
  }

  return healthy("traefik", parsed ?? "unknown", true);
}

export async function checkGit(
  executor: CommandExecutor,
): Promise<ComponentStatus> {
  const version = await tryExec(executor, "git --version");
  if (!version) {
    return unhealthy("git", "Git is not installed");
  }
  const parsed = version.match(/git version (\S+)/)?.[1] ?? version;
  return healthy("git", parsed);
}

export async function checkNode(
  executor: CommandExecutor,
): Promise<ComponentStatus> {
  const version = await tryExec(executor, "node --version");
  if (!version) {
    return unhealthy("node", "Node.js is not installed");
  }
  return healthy("node", version.replace(/^v/, ""));
}

export async function checkBun(
  executor: CommandExecutor,
): Promise<ComponentStatus> {
  const version = await tryExec(executor, "bun --version");
  if (!version) {
    return unhealthy("bun", "Bun is not installed");
  }
  return healthy("bun", version);
}

// ─── Registry ────────────────────────────────────────────────────────────────

type CheckFn = (executor: CommandExecutor) => Promise<ComponentStatus>;

export const COMPONENT_CHECKS: Record<string, CheckFn> = {
  docker: checkDocker,
  traefik: checkTraefik,
  git: checkGit,
  node: checkNode,
  bun: checkBun,
};

/** Run every registered check in parallel. */
export async function checkAll(
  executor: CommandExecutor,
): Promise<ComponentStatus[]> {
  const entries = Object.entries(COMPONENT_CHECKS);
  return Promise.all(entries.map(([, fn]) => fn(executor)));
}

/** Run checks for a specific set of components. */
export async function checkComponents(
  executor: CommandExecutor,
  names: string[],
): Promise<ComponentStatus[]> {
  const fns = names
    .map((name) => COMPONENT_CHECKS[name])
    .filter(Boolean);
  return Promise.all(fns.map((fn) => fn(executor)));
}
