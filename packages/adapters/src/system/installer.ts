/**
 * Component installers & uninstallers.
 *
 * Each component has a simple install/uninstall function. No shared
 * abstractions — each does exactly what it needs. All commands run
 * through CommandExecutor (SSH or local).
 */

import type { CommandExecutor, LogEntry } from "../types";
import type { InstallerConfig, InstallResult, SystemLogCallback, SystemLog } from "./types";
import { systemCatalog } from "./catalog";
import { resolveEnvironment, type EnvironmentProfile } from "./environment";
import {
  deployLuaScripts,
  detectOpenRestyPaths,
  buildReloadCommand,
  ensureOpenRestyConfig,
  OPENRESTY_DEFAULT_PATHS,
  type OpenRestyPaths,
} from "../infra/openresty-lua";

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
  const profile = await resolveEnvironment(executor);
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
    const msg = err instanceof Error ? err.message : String(err);
    onLog(log(`Docker installation failed: ${msg}`, "error"));
    return { component: "docker", success: false, error: msg };
  }
}

// ─── Git ─────────────────────────────────────────────────────────────────────

export async function installGit(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const profile = await resolveEnvironment(executor);
  const plan = systemCatalog.installs.git(profile);
  if (!plan.supported || !plan.installCommand || !plan.verifyCommand) {
    return { component: "git", success: false, error: plan.unsupportedReason ?? "Git install not supported" };
  }

  onLog(log("Installing Git..."));
  try {
    const { code } = await executor.streamExec(plan.installCommand, onLog as (log: LogEntry) => void);
    if (code !== 0) return { component: "git", success: false, error: "Git installation failed" };

    const version = await executor.exec(plan.verifyCommand);
    const parsed = systemCatalog.checks.git.parseVersion(version);
    onLog(log(`Git ${parsed} installed`));
    return { component: "git", success: true, version: parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog(log(`Git installation failed: ${msg}`, "error"));
    return { component: "git", success: false, error: msg };
  }
}

// ─── Rsync ───────────────────────────────────────────────────────────────────

export async function installRsync(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const profile = await resolveEnvironment(executor);
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
    const msg = err instanceof Error ? err.message : String(err);
    onLog(log(`rsync installation failed: ${msg}`, "error"));
    return { component: "rsync", success: false, error: msg };
  }
}

// ─── Certbot ─────────────────────────────────────────────────────────────────

export async function installCertbot(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const profile = await resolveEnvironment(executor);
  const plan = systemCatalog.installs.certbot(profile);
  if (!plan.supported || !plan.installCommand || !plan.verifyCommand) {
    return { component: "certbot", success: false, error: plan.unsupportedReason ?? "Certbot install not supported" };
  }

  onLog(log("Installing certbot..."));
  try {
    const { code } = await executor.streamExec(plan.installCommand, onLog as (log: LogEntry) => void);
    if (code !== 0) return { component: "certbot", success: false, error: "Certbot installation failed" };

    const version = await executor.exec(plan.verifyCommand);
    const parsed = systemCatalog.checks.certbot.parseVersion(version);
    onLog(log(`Certbot ${parsed} installed`));
    return { component: "certbot", success: true, version: parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog(log(`Certbot installation failed: ${msg}`, "error"));
    return { component: "certbot", success: false, error: msg };
  }
}

// ─── OpenResty ───────────────────────────────────────────────────────────────

export async function installOpenResty(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const profile = await resolveEnvironment(executor);
  onLog(log(describeEnvironment(profile)));
  const plan = systemCatalog.installs.openresty(profile);
  if (!plan.supported || !plan.installCommand || !plan.verifyCommand) {
    return { component: "openresty", success: false, error: plan.unsupportedReason ?? "OpenResty install not supported" };
  }

  onLog(log("Installing OpenResty..."));
  try {
    // Stop existing if present
    const hasIt = await executor.exec("command -v openresty >/dev/null 2>&1 && echo y || echo n").then((r) => r.trim() === "y");
    if (hasIt) {
      onLog(log("Stopping existing OpenResty..."));
      await execSafe(executor, "systemctl stop openresty 2>/dev/null || true");
      await execSafe(executor, "pkill -f '[o]penresty' 2>/dev/null || true");
    }

    if (profile.packageManager === "apt") {
      await ensureAptReady(executor, onLog);
    }

    // Install package
    const { code } = await executor.streamExec(plan.installCommand, onLog as (log: LogEntry) => void);
    if (code !== 0) return { component: "openresty", success: false, error: "OpenResty installation failed" };

    // Stop auto-started instance, write our config, then start
    await execSafe(executor, "systemctl stop openresty 2>/dev/null || true");
    await execSafe(executor, "pkill -f '[o]penresty' 2>/dev/null || true");
    await execSafe(executor, "systemctl reset-failed openresty 2>/dev/null || true");

    const paths = await detectOpenRestyPaths(executor);
    await ensureOpenRestyConfig(executor, paths);

    // Validate config
    onLog(log("Validating config..."));
    const { code: testCode } = await executor.streamExec(`${paths.bin} -t 2>&1`, onLog as (log: LogEntry) => void);
    if (testCode !== 0) {
      return { component: "openresty", success: false, error: "OpenResty config invalid — see logs above" };
    }

    // Start service
    if (plan.startCommand) {
      onLog(log("Starting OpenResty..."));
      const start = await executor.streamExec(plan.startCommand, onLog as (log: LogEntry) => void);
      if (start.code !== 0) {
        onLog(log("Start failed — clearing port 80...", "warn"));
        await execSafe(executor, "fuser -k 80/tcp 2>/dev/null || true");
        await execSafe(executor, "systemctl reset-failed openresty 2>/dev/null || true");
        const retry = await executor.streamExec(plan.startCommand, onLog as (log: LogEntry) => void);
        if (retry.code !== 0) {
          const journal = await executor.exec(
            "journalctl -xeu openresty.service --no-pager -n 30 2>/dev/null || echo '(unavailable)'",
          ).catch(() => "(could not read journal)");
          onLog(log(`Service journal:\n${journal}`, "error"));
          return { component: "openresty", success: false, error: "OpenResty installed but failed to start" };
        }
      }
    }

    // Reload, deploy scripts, verify
    await executor.exec(buildReloadCommand(paths));
    onLog(log("Deploying analytics scripts..."));
    await deployLuaScripts(executor, paths);

    const version = await executor.exec(plan.verifyCommand);
    const parsed = systemCatalog.checks.openresty.parseVersion(version);
    onLog(log(`OpenResty ${parsed} installed`));
    return { component: "openresty", success: true, version: parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog(log(`OpenResty installation failed: ${msg}`, "error"));
    return { component: "openresty", success: false, error: msg };
  }
}

// ─── Uninstallers ────────────────────────────────────────────────────────────

export async function uninstallRsync(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const profile = await resolveEnvironment(executor);
  const cmd = buildRemoveCommand(profile.packageManager, ["rsync"]);
  if (!cmd) return { component: "rsync", success: false, error: "rsync removal not supported" };

  onLog(log("Removing rsync..."));
  try {
    const { code } = await executor.streamExec(cmd, onLog as (log: LogEntry) => void);
    if (code !== 0) return { component: "rsync", success: false, error: "rsync removal failed" };
    onLog(log("rsync removed"));
    return { component: "rsync", success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { component: "rsync", success: false, error: msg };
  }
}

export async function uninstallCertbot(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const profile = await resolveEnvironment(executor);
  const cmd = buildRemoveCommand(profile.packageManager, ["certbot"]);
  if (!cmd) return { component: "certbot", success: false, error: "Certbot removal not supported" };

  onLog(log("Removing certbot..."));
  try {
    const { code } = await executor.streamExec(cmd, onLog as (log: LogEntry) => void);
    if (code !== 0) return { component: "certbot", success: false, error: "Certbot removal failed" };
    onLog(log("Certbot removed"));
    return { component: "certbot", success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { component: "certbot", success: false, error: msg };
  }
}

export async function uninstallOpenResty(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const profile = await resolveEnvironment(executor);

  try {
    // 1. Stop
    onLog(log("Stopping OpenResty..."));
    await execSafe(executor, "systemctl stop openresty 2>/dev/null || true");
    await execSafe(executor, "pkill -f '[o]penresty' 2>/dev/null || true");
    await execSafe(executor, "fuser -k 80/tcp 2>/dev/null || true");

    // 2. Remove package
    const removeCmd = buildRemoveCommand(profile.packageManager, ["openresty"]);
    if (removeCmd) {
      if (profile.packageManager === "apt") {
        await ensureAptReady(executor, onLog);
      }
      onLog(log("Removing OpenResty package..."));
      const { code } = await executor.streamExec(removeCmd, onLog as (log: LogEntry) => void);
      if (code !== 0) return { component: "openresty", success: false, error: "Package removal failed" };
    }

    // 3. Clean up leftover files
    onLog(log("Cleaning up files..."));
    let paths: OpenRestyPaths;
    try {
      paths = await detectOpenRestyPaths(executor);
    } catch {
      paths = OPENRESTY_DEFAULT_PATHS;
    }
    const root = paths.bin.includes("/openresty/") ? paths.bin.replace(/\/bin\/[^/]+$/, "") : "/usr/local/openresty";

    await execSafe(executor, [
      `rm -rf ${root}`,
      `rm -rf ${paths.confDir}`,
      "rm -rf /etc/openresty",
      "rm -rf /usr/local/openresty",
      "rm -f /etc/apt/sources.list.d/openresty.list",
      "rm -f /usr/share/keyrings/openresty.gpg",
      "rm -f /etc/yum.repos.d/openresty.repo",
    ].join(" && "));

    onLog(log("OpenResty removed"));
    return { component: "openresty", success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog(log(`OpenResty removal failed: ${msg}`, "error"));
    return { component: "openresty", success: false, error: msg };
  }
}

// ─── Removal support check ──────────────────────────────────────────────────

export async function getRemovalSupport(
  executor: CommandExecutor,
  componentName: string,
): Promise<{ supported: boolean; reason?: string }> {
  const profile = await resolveEnvironment(executor);
  if (profile.os !== "linux" && componentName === "openresty") {
    return { supported: false, reason: "OpenResty removal only supported on Linux" };
  }
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
  openresty: (exec, log) => installOpenResty(exec, log),
  certbot: (exec, log) => installCertbot(exec, log),
  git: (exec, log) => installGit(exec, log),
  rsync: (exec, log) => installRsync(exec, log),
};

export const COMPONENT_UNINSTALLERS: Record<string, InstallerFn> = {
  openresty: (exec, log) => uninstallOpenResty(exec, log),
  certbot: (exec, log) => uninstallCertbot(exec, log),
  rsync: (exec, log) => uninstallRsync(exec, log),
};
