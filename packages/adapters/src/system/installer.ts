/**
 * Component installers & uninstallers.
 *
 * Each component has a simple install/uninstall function. No shared
 * abstractions - each does exactly what it needs. All commands run
 * through CommandExecutor (SSH or local).
 */

import type { CommandExecutor, LogEntry } from "../types";
import type { InstallerConfig, InstallResult, SystemLogCallback, SystemLog } from "./types";
import { systemCatalog } from "./catalog";
import { resolveEnvironment, type EnvironmentProfile } from "./environment";
import { elevatedExecutor } from "./elevated-executor";
import { safeErrorMessage } from "@repo/core";
import {
  EdgeMigrateRequested,
  invalidateEdgeContainer,
  resolveOurEdgeContainer,
} from "./proxy/detect";
import { probeListeningPort } from "../runtime/port-conflict";
import { dockerAvailable } from "./managed-image";
import { ensureContainerEdge } from "./proxy/ensure-container-edge";
import { containerCommand } from "./edge-container-executor";
import { sq } from "./local-shell";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(message: string, level: SystemLog["level"] = "info"): SystemLog {
  return { timestamp: new Date().toISOString(), message, level };
}

function describeEnvironment(profile: EnvironmentProfile): string {
  return `Detected environment: os=${profile.os}, arch=${profile.arch}, distro=${profile.distro ?? "n/a"}, packageManager=${profile.packageManager}, serviceManager=${profile.serviceManager}`;
}

/** Run a command, swallow errors (best-effort). */
async function execSafe(executor: CommandExecutor, cmd: string): Promise<void> {
  try {
    await executor.exec(cmd);
  } catch {}
}

/**
 * Kill stale apt/dpkg locks and fix interrupted state.
 * Only needed on apt systems when dpkg got interrupted.
 */
async function ensureAptReady(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<void> {
  const broken = await executor.exec("dpkg --audit 2>&1 | head -1").catch(() => "");
  if (!broken) return;

  onLog(log("Fixing interrupted package state..."));
  await execSafe(executor, "fuser -k /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock 2>/dev/null || true");
  await execSafe(executor, "rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock 2>/dev/null || true");
  // DPKG_FORCE=confnew is set in the SSH env prefix, so this won't hang on conffile prompts
  await executor.streamExec("dpkg --configure -a 2>&1", onLog as (log: LogEntry) => void);
}

type ExecutorPrep =
  | { ok: true; executor: CommandExecutor; profile: EnvironmentProfile }
  | { ok: false; result: InstallResult };

/**
 * Resolve the environment and pick the executor to run privileged install/remove
 * commands through. Root → the executor as-is. Non-root with passwordless sudo →
 * an {@link elevatedExecutor} that prefixes every command with `sudo -n`. Neither
 * → fail fast with an actionable message (component installs run apt/systemctl/
 * writes under /etc, which need root — running them unelevated is the #84 apt-lock
 * failure). Call this BEFORE touching the box (e.g. before stopping OpenResty).
 */
async function prepareExecutor(
  executor: CommandExecutor,
  component: string,
): Promise<ExecutorPrep> {
  const profile = await resolveEnvironment(executor);
  if (profile.isRoot) return { ok: true, executor, profile };
  if (profile.canSudo) return { ok: true, executor: elevatedExecutor(executor), profile };
  return {
    ok: false,
    result: {
      component,
      success: false,
      error: `Installing ${component} needs root. Connect this server as root, or as a user with passwordless sudo.`,
    },
  };
}

/** Build the package-manager remove command. */
function buildRemoveCommand(pm: EnvironmentProfile["packageManager"], packages: string[]): string | null {
  const names = packages.join(" ");
  switch (pm) {
    case "apt":  return `apt-get purge -y -qq ${names} && apt-get autoremove -y -qq`;
    case "dnf":  return `dnf remove -y ${names}`;
    case "yum":  return `yum remove -y ${names}`;
    case "brew": return `brew uninstall --force ${names}`;
    case "apk":  return `apk del ${names}`;
    default:     return null;
  }
}

// ─── Docker ──────────────────────────────────────────────────────────────────

export async function installDocker(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const prep = await prepareExecutor(executor, "docker");
  if (!prep.ok) return prep.result;
  executor = prep.executor;
  const profile = prep.profile;
  const plan = systemCatalog.installs.docker(profile);
  if (!plan.supported || !plan.installCommand || !plan.verifyCommand) {
    return { component: "docker", success: false, error: plan.unsupportedReason ?? "Docker install not supported" };
  }

  onLog(log("Installing Docker Engine..."));
  try {
    const { code } = await executor.streamExec(plan.installCommand, onLog as (log: LogEntry) => void);
    if (code !== 0) return { component: "docker", success: false, error: "Docker install failed" };

    if (plan.startCommand) {
      onLog(log("Starting Docker service..."));
      await executor.streamExec(plan.startCommand, onLog as (log: LogEntry) => void);
    }

    const version = await executor.exec(plan.verifyCommand);
    const parsed = systemCatalog.checks.docker.parseVersion(version);
    onLog(log(`Docker ${parsed} installed`));
    return { component: "docker", success: true, version: parsed };
  } catch (err) {
    const msg = safeErrorMessage(err);
    onLog(log(`Docker installation failed: ${msg}`, "error"));
    return { component: "docker", success: false, error: msg };
  }
}

// ─── Git ─────────────────────────────────────────────────────────────────────

export async function installGit(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
  opts?: { label?: string },
): Promise<InstallResult> {
  const prep = await prepareExecutor(executor, "git");
  if (!prep.ok) return prep.result;
  executor = prep.executor;
  const profile = prep.profile;
  const plan = systemCatalog.installs.git(profile);
  if (!plan.supported || !plan.installCommand || !plan.verifyCommand) {
    return { component: "git", success: false, error: plan.unsupportedReason ?? "Git install not supported" };
  }

  onLog(log(opts?.label ? `Installing Git in ${opts.label}...` : "Installing Git..."));
  try {
    const { code } = await executor.streamExec(plan.installCommand, onLog as (log: LogEntry) => void);
    if (code !== 0) return { component: "git", success: false, error: "Git installation failed" };

    const version = await executor.exec(plan.verifyCommand);
    const parsed = systemCatalog.checks.git.parseVersion(version);
    onLog(log(opts?.label ? `Git ${parsed} installed in ${opts.label}` : `Git ${parsed} installed`));
    return { component: "git", success: true, version: parsed };
  } catch (err) {
    const msg = safeErrorMessage(err);
    onLog(log(`Git installation failed: ${msg}`, "error"));
    return { component: "git", success: false, error: msg };
  }
}

// ─── Rsync ───────────────────────────────────────────────────────────────────

export async function installRsync(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const prep = await prepareExecutor(executor, "rsync");
  if (!prep.ok) return prep.result;
  executor = prep.executor;
  const profile = prep.profile;
  const plan = systemCatalog.installs.rsync(profile);
  if (!plan.supported || !plan.installCommand || !plan.verifyCommand) {
    return { component: "rsync", success: false, error: plan.unsupportedReason ?? "rsync install not supported" };
  }

  onLog(log("Installing rsync..."));
  try {
    const { code } = await executor.streamExec(plan.installCommand, onLog as (log: LogEntry) => void);
    if (code !== 0) return { component: "rsync", success: false, error: "rsync installation failed" };

    const version = await executor.exec(plan.verifyCommand);
    const parsed = systemCatalog.checks.rsync.parseVersion(version);
    onLog(log(`rsync ${parsed} installed`));
    return { component: "rsync", success: true, version: parsed };
  } catch (err) {
    const msg = safeErrorMessage(err);
    onLog(log(`rsync installation failed: ${msg}`, "error"));
    return { component: "rsync", success: false, error: msg };
  }
}

/**
 * Install the edge — the `edge` component. It is a CONTAINER, always.
 *
 * The edge is the openship-edge image and its serving path is host-side (host
 * networking, host bind mounts for vhosts/certs/ACME). There is deliberately NO
 * host-package fallback: a Docker-less box gets an explicit, actionable failure
 * instead of a second, divergent edge implementation that then has to be migrated.
 *
 * THE only way to install an edge. There is no `installOpenResty`/`installCertbot`
 * any more — both apt-installed a host-side edge, and the mail wizard was the last
 * caller keeping them alive. That left one box able to end up with two edge
 * implementations, a certbot on the host that only mail's cert step used, and a
 * second copy of the conflict handling. `ensureContainerEdge` below still converts
 * a PRE-EXISTING host OpenResty (bare→container), which is how boxes installed
 * before this move come across.
 */
export async function installContainerEdge(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
  config?: InstallerConfig,
): Promise<InstallResult> {
  // Elevate: `docker` may need sudo, and the host state dirs live under /var/lib
  // and /etc.
  const prep = await prepareExecutor(executor, "edge");
  if (!prep.ok) return prep.result;
  executor = prep.executor;

  if (!(await dockerAvailable(executor))) {
    const error =
      "The edge is a container image and needs Docker on this server. " +
      "Install the Docker component first, then install the edge.";
    onLog(log(error, "error"));
    return { component: "edge", success: false, error };
  }

  try {
    const result = await ensureContainerEdge(executor, {
      onLog,
      config,
      image: config?.edgeImage,
    });
    if (result.converted) {
      onLog(log("Edge moved from host OpenResty to the container edge", "warn"));
    }
    const version = await executor
      .exec(containerCommand(result.container, "openresty -v 2>&1"))
      .catch(() => "");
    return {
      component: "edge",
      success: true,
      version: version ? systemCatalog.checks.openresty.parseVersion(version) : undefined,
    };
  } catch (err) {
    // The migrate signal must reach the caller (which runs the takeover
    // orchestration) — don't swallow it into a failed InstallResult.
    if (err instanceof EdgeMigrateRequested) throw err;
    const msg = safeErrorMessage(err);
    onLog(log(`Edge setup failed: ${msg}`, "error"));
    return { component: "edge", success: false, error: msg };
  }
}

// ─── Uninstallers ────────────────────────────────────────────────────────────

export async function uninstallRsync(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const prep = await prepareExecutor(executor, "rsync");
  if (!prep.ok) return prep.result;
  executor = prep.executor;
  const cmd = buildRemoveCommand(prep.profile.packageManager, ["rsync"]);
  if (!cmd) return { component: "rsync", success: false, error: "rsync removal not supported" };

  onLog(log("Removing rsync..."));
  try {
    const { code } = await executor.streamExec(cmd, onLog as (log: LogEntry) => void);
    if (code !== 0) return { component: "rsync", success: false, error: "rsync removal failed" };
    onLog(log("rsync removed"));
    return { component: "rsync", success: true };
  } catch (err) {
    const msg = safeErrorMessage(err);
    return { component: "rsync", success: false, error: msg };
  }
}

export async function uninstallEdge(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const prep = await prepareExecutor(executor, "edge");
  if (!prep.ok) return prep.result;
  executor = prep.executor;

  // `fresh`: we are about to REMOVE it, so a stale positive would `docker rm` a
  // name that no longer exists and report success over an untouched box.
  const container = await resolveOurEdgeContainer(executor, { fresh: true }).catch(() => null);
  if (!container) {
    onLog(log("No edge container on this server — nothing to remove."));
    return { component: "edge", success: true };
  }

  onLog(log(`Removing the edge container ${container}...`));
  // Clear the restart policy first, or the daemon brings it straight back.
  await execSafe(executor, `docker update --restart=no ${sq(container)} 2>/dev/null || true`);
  await execSafe(executor, `docker rm -f ${sq(container)} 2>/dev/null || true`);
  invalidateEdgeContainer(executor);
  // Certs and vhosts stay on the host on purpose — same rule as the compose
  // uninstall: issued certificates outlive a reinstall, and /etc/letsencrypt may be
  // shared with the mail server. Removing them is the operator's call.
  onLog(log("Edge removed. Certificates and vhosts were left on the host."));
  return { component: "edge", success: true };
}

// ─── Removal support check ──────────────────────────────────────────────────

export async function getRemovalSupport(
  executor: CommandExecutor,
  componentName: string,
): Promise<{ supported: boolean; reason?: string }> {
  // The edge is a container: removal needs the daemon, not a package manager.
  if (componentName === "edge") return { supported: true };
  const profile = await resolveEnvironment(executor);
  const cmd = buildRemoveCommand(profile.packageManager, [componentName]);
  return cmd
    ? { supported: true }
    : { supported: false, reason: `No package manager to remove ${componentName}` };
}

// ─── Registry ────────────────────────────────────────────────────────────────

type InstallerFn = (
  executor: CommandExecutor,
  onLog: SystemLogCallback,
  config?: InstallerConfig,
) => Promise<InstallResult>;

export const COMPONENT_INSTALLERS: Record<string, InstallerFn> = {
  docker: (exec, log) => installDocker(exec, log),
  // The edge is ONE component and it is a container image — there is no
  // host-OpenResty or host-certbot installer to reach for any more.
  edge: (exec, log, config) => installContainerEdge(exec, log, config),
  git: (exec, log) => installGit(exec, log),
  rsync: (exec, log) => installRsync(exec, log),
};

export const COMPONENT_UNINSTALLERS: Record<string, InstallerFn> = {
  edge: (exec, log) => uninstallEdge(exec, log),
  rsync: (exec, log) => uninstallRsync(exec, log),
};
