/**
 * Component health checks - detect installed binaries and running services.
 *
 * All checks run through a CommandExecutor, so they work both locally
 * and on remote servers via SSH. Checks are fast, non-destructive, and
 * safe to run repeatedly.
 *
 * In normal operation, checks run ONCE during setup - the result is
 * cached in SetupStateStore. Subsequent operations read cached state
 * instead of re-running checks (see setup.ts).
 */

import type { CommandExecutor } from "../types";
import type { ComponentStatus } from "./types";
import { containerCommand } from "./edge-container-executor";
import { resolveOurEdgeContainer } from "./proxy/detect";
// Direct module, not the `./proxy` barrel: that barrel pulls in the takeover path,
// which imports this file.
import { verifyEdgeServing } from "./proxy/ensure-container-edge";
import { systemCatalog } from "./catalog";
import { resolveEnvironment } from "./environment";
import { enrichAvailableVersions } from "./available-version";
import { getSystemComponentDefinition, SYSTEM_COMPONENTS } from "./components";
import { formatDuration, systemDebug } from "./debug";
import { isRemoteConnectionError } from "./errors";
import { safeErrorMessage } from "@repo/core";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A probe's outcome. `output` is stdout on exit 0 (possibly empty); `error` is the
 * failure text, null when the command ran.
 *
 * The two are deliberately NOT collapsed into one `string | null`. That is what
 * made #408 undiagnosable: a probe that FAILED and a probe that returned nothing
 * produced the identical static "the daemon is not running", so the daemon's own
 * answer — "permission denied while trying to connect to the Docker daemon
 * socket", "Cannot connect to the Docker daemon", "Command timed out after
 * 10000ms" — was read off the wire, logged behind SYSTEM_DEBUG_LOGS, and then
 * discarded in favour of a guess the reporter had no way to check.
 */
interface ExecOutcome {
  output: string;
  error: string | null;
}

/** Run a command via executor; never throws except on a transport drop. */
async function tryExec(
  executor: CommandExecutor,
  command: string,
): Promise<ExecOutcome> {
  const startedAt = Date.now();
  systemDebug("checks", `exec:start ${command}`);
  try {
    const result = await executor.exec(command, { timeout: 10_000 });
    systemDebug(
      "checks",
      `exec:ok ${command} (${formatDuration(startedAt)})`,
    );
    // Trimmed so "did this produce anything" is an honest test — a
    // whitespace-only reply from a half-answering daemon is not output.
    return { output: result.trim(), error: null };
  } catch (err) {
    if (isRemoteConnectionError(err)) {
      systemDebug(
        "checks",
        `exec:abort ${command} (${formatDuration(startedAt)}) ${safeErrorMessage(err)}`,
      );
      throw err;
    }
    const msg = safeErrorMessage(err);
    systemDebug(
      "checks",
      `exec:fail ${command} (${formatDuration(startedAt)}) ${msg}`,
    );
    return { output: "", error: msg || `\`${command}\` failed` };
  }
}

/**
 * Fold a probe's own failure text into the component message, so the UI states the
 * cause instead of repeating a guess. Server owners read this string and act on it;
 * they have a shell on the same box, so there is nothing here they can't already see.
 *
 * First line only, capped: `docker info` and certbot can answer with a paragraph,
 * and the message renders inline in the Components tab.
 */
function withReason(message: string, error: string | null): string {
  if (!error) return message;
  const first = error
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return message;
  return `${message} — ${first.length > 200 ? `${first.slice(0, 199)}…` : first}`;
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
      ? `${name} ${version} - running`
      : `${name} ${version} - installed`,
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
  if (!version.output) {
    systemDebug("checks", `docker:missing (${formatDuration(startedAt)})`);
    return unhealthy("docker", withReason(recipe.missingMessage, version.error));
  }

  const parsed = recipe.parseVersion(version.output);

  // Two distinct diagnoses, one verdict: the probe failed (error carries why), or
  // it exited 0 without naming a server version (daemon answered nothing useful).
  // Both mean "not running" — only the first can explain itself.
  const info = await tryExec(executor, recipe.daemonCommand!);
  if (!info.output) {
    systemDebug(
      "checks",
      `docker:not-running (${formatDuration(startedAt)}) ${info.error ?? "probe exited 0 with no server version"}`,
    );
    return unhealthy("docker", withReason(recipe.notRunningMessage!, info.error), {
      version: parsed,
      running: false,
    });
  }

  systemDebug("checks", `docker:healthy (${formatDuration(startedAt)})`);
  return healthy("docker", parsed, true);
}

export async function checkGit(
  executor: CommandExecutor,
): Promise<ComponentStatus> {
  const startedAt = Date.now();
  const recipe = systemCatalog.checks.git;
  const version = await tryExec(executor, recipe.versionCommand);
  if (!version.output) {
    systemDebug("checks", `git:missing (${formatDuration(startedAt)})`);
    return unhealthy("git", withReason(recipe.missingMessage, version.error));
  }
  const parsed = recipe.parseVersion(version.output);
  systemDebug("checks", `git:healthy (${formatDuration(startedAt)})`);
  return healthy("git", parsed);
}

export async function checkRsync(
  executor: CommandExecutor,
): Promise<ComponentStatus> {
  const startedAt = Date.now();
  const recipe = systemCatalog.checks.rsync;
  const version = await tryExec(executor, recipe.versionCommand);
  if (!version.output) {
    systemDebug("checks", `rsync:missing (${formatDuration(startedAt)})`);
    return unhealthy("rsync", withReason(recipe.missingMessage, version.error));
  }
  const parsed = recipe.parseVersion(version.output);
  systemDebug("checks", `rsync:healthy (${formatDuration(startedAt)})`);
  return healthy("rsync", parsed);
}

/**
 * The edge: is our openship-edge container SERVING.
 *
 * The edge is a Docker image whose serving path is host-side (host networking, host
 * bind mounts for vhosts/certs/ACME), so there is no host binary, no unit and no Lua
 * on the box to probe — and nothing to fall back to. A box without the container has
 * no edge; installing one is a container pull.
 *
 * "Resolved" is deliberately NOT the verdict. `resolveOurEdgeContainer` reads plain
 * `docker ps`, and docker reports a container crash-looping on
 * `bind() … (98: Address already in use)` as running — so a box whose edge had never
 * bound :80 could answer this check with a version and render healthy, because a
 * `docker exec` landing in the brief up-window between restarts succeeds. The serving
 * question therefore goes to `verifyEdgeServing`, the ONE definition every other edge
 * path uses, so all of them name the same cause instead of this surface guessing
 * "running but not responding" and sending the operator to the wrong place.
 */
export async function checkEdge(executor: CommandExecutor): Promise<ComponentStatus> {
  const startedAt = Date.now();

  const container = await resolveOurEdgeContainer(executor);
  if (!container) {
    systemDebug("checks", `edge:missing (${formatDuration(startedAt)})`);
    return unhealthy(
      "edge",
      "No edge on this server. The edge is the openship-edge container — install it (requires Docker).",
    );
  }

  const verdict = await verifyEdgeServing(executor, container);
  if (!verdict.serving) {
    systemDebug("checks", `edge:not-serving (${formatDuration(startedAt)})`);
    return unhealthy(
      "edge",
      `The edge container ${container} is not serving — ${verdict.reason ?? "it is not listening on :80"}`,
      { running: false },
    );
  }

  const version = await tryExec(executor, containerCommand(container, "openresty -v 2>&1"));
  if (!version.output) {
    systemDebug("checks", `edge:container-unresponsive (${formatDuration(startedAt)})`);
    return unhealthy(
      "edge",
      withReason(
        `The edge container ${container} is serving on :80 but not answering — check \`docker logs ${container}\``,
        version.error,
      ),
      { running: false },
    );
  }

  systemDebug("checks", `edge:healthy (${formatDuration(startedAt)})`);
  return healthy("edge", systemCatalog.checks.openresty.parseVersion(version.output), true);
}

// ─── Registry ────────────────────────────────────────────────────────────────

type CheckFn = (executor: CommandExecutor) => Promise<ComponentStatus>;

export const COMPONENT_CHECKS: Record<string, CheckFn> = {
  docker: checkDocker,
  edge: checkEdge,
  git: checkGit,
  rsync: checkRsync,
};

/**
 * Map items through `fn` with a bounded concurrency pool, preserving order.
 *
 * Component checks are independent, so we run several at once instead of
 * serially — a big win on the system-ssh path where every `exec` is a separate
 * `ssh` round-trip (serial checks otherwise stack past the client timeout). The
 * cap keeps us well under sshd's per-connection MaxSessions (default 10), which
 * both ssh2 channels and ControlMaster sessions draw from, leaving headroom for
 * the live-metrics stream sharing the same connection.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/** Max component checks to run concurrently (see mapWithConcurrency). */
const CHECK_CONCURRENCY = 4;

/** Run every registered check with bounded concurrency. */
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
  const results = await mapWithConcurrency(entries, CHECK_CONCURRENCY, ([, fn]) =>
    fn(executor),
  );
  await enrichAvailable(executor, results);
  systemDebug("checks", `checkAll:done (${formatDuration(startedAt)})`);
  return results;
}

/** Best-effort "newer version available?" enrichment; never throws. */
async function enrichAvailable(
  executor: CommandExecutor,
  results: ComponentStatus[],
): Promise<void> {
  try {
    const profile = await resolveEnvironment(executor);
    await enrichAvailableVersions(executor, profile, results);
  } catch {
    /* leave components without an available version */
  }
}

/** Run checks for a specific set of components with bounded concurrency. */
export async function checkComponents(
  executor: CommandExecutor,
  names: string[],
): Promise<ComponentStatus[]> {
  const startedAt = Date.now();
  const fns = names
    .map((name) => COMPONENT_CHECKS[name])
    .filter((fn): fn is CheckFn => Boolean(fn));
  systemDebug("checks", `checkComponents:start [${names.join(", ")}]`);
  const results = await mapWithConcurrency(fns, CHECK_CONCURRENCY, (fn) =>
    fn(executor),
  );
  await enrichAvailable(executor, results);
  systemDebug(
    "checks",
    `checkComponents:done [${names.join(", ")}] (${formatDuration(startedAt)})`,
  );
  return results;
}
