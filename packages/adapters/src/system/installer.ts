/**
 * Component installers — actively install software on servers.
 *
 * All commands run through a CommandExecutor, so installation works on
 * both the local machine and remote servers via SSH. Logs stream in
 * real time through SystemLogCallback.
 *
 * Pre-collected configuration:
 *   Installers accept InstallerConfig for values that would normally
 *   require interactive input (ACME email, domain, etc.). The dashboard
 *   or CLI collects these from the user BEFORE starting setup, so the
 *   entire installation runs non-interactively.
 *
 * Security:
 *   - All commands use hardcoded arguments — no user input interpolated
 *     into shell strings (InstallerConfig values are validated first)
 *   - DEBIAN_FRONTEND=noninteractive is set by the executor
 */

import type { CommandExecutor, LogEntry } from "../types";
import type { InstallerConfig, InstallResult, SystemLogCallback, SystemLog } from "./types";
import { systemCatalog } from "./catalog";
import { resolveEnvironment } from "./environment";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(
  message: string,
  level: SystemLog["level"] = "info",
): SystemLog {
  return { timestamp: new Date().toISOString(), message, level };
}

function describeEnvironment(profile: Awaited<ReturnType<typeof resolveEnvironment>>): string {
  return `Detected environment: os=${profile.os}, arch=${profile.arch}, distro=${profile.distro ?? "n/a"}, packageManager=${profile.packageManager}, serviceManager=${profile.serviceManager}`;
}

// ─── Docker ──────────────────────────────────────────────────────────────────

export async function installDocker(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const profile = await resolveEnvironment(executor);
  const plan = systemCatalog.installs.docker(profile);
  if (!plan.supported || !plan.installCommand || !plan.verifyCommand) {
    return {
      component: "docker",
      success: false,
      error: `${plan.unsupportedReason ?? "Docker installation is not supported on this environment"}. ${describeEnvironment(profile)}`,
    };
  }

  onLog(log("Installing Docker Engine via official script..."));

  try {
    const { code } = await executor.streamExec(
      plan.installCommand,
      onLog as (log: LogEntry) => void,
    );
    if (code !== 0) {
      return { component: "docker", success: false, error: "Docker install script failed" };
    }

    if (plan.startCommand) {
      onLog(log("Enabling and starting Docker service..."));
      await executor.streamExec(
        plan.startCommand,
        onLog as (log: LogEntry) => void,
      );
    }

    onLog(log("Verifying Docker installation..."));
    const version = await executor.exec(plan.verifyCommand);
    const parsed = systemCatalog.checks.docker.parseVersion(version);

    onLog(log(`Docker ${parsed} installed successfully`));
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
    return {
      component: "git",
      success: false,
      error: plan.unsupportedReason ?? "Git installation is not supported on this environment",
    };
  }

  onLog(log("Installing Git..."));

  try {
    const { code } = await executor.streamExec(
      plan.installCommand,
      onLog as (log: LogEntry) => void,
    );
    if (code !== 0) {
      return { component: "git", success: false, error: "Git installation failed" };
    }

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

export async function installRsync(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const profile = await resolveEnvironment(executor);
  const plan = systemCatalog.installs.rsync(profile);
  if (!plan.supported || !plan.installCommand || !plan.verifyCommand) {
    return {
      component: "rsync",
      success: false,
      error: plan.unsupportedReason ?? "rsync installation is not supported on this environment",
    };
  }

  onLog(log("Installing rsync..."));

  try {
    const { code } = await executor.streamExec(
      plan.installCommand,
      onLog as (log: LogEntry) => void,
    );
    if (code !== 0) {
      return { component: "rsync", success: false, error: "rsync installation failed" };
    }

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

// ─── Nginx ────────────────────────────────────────────────────────────────────

export async function installNginx(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const profile = await resolveEnvironment(executor);
  const plan = systemCatalog.installs.nginx(profile);
  if (!plan.supported || !plan.installCommand || !plan.verifyCommand) {
    return {
      component: "nginx",
      success: false,
      error: plan.unsupportedReason ?? "Nginx installation is not supported on this environment",
    };
  }

  onLog(log("Installing Nginx and certbot..."));

  try {
    const { code } = await executor.streamExec(
      plan.installCommand,
      onLog as (log: LogEntry) => void,
    );
    if (code !== 0) {
      return { component: "nginx", success: false, error: "Nginx installation failed" };
    }

    if (plan.startCommand) {
      onLog(log("Enabling and starting Nginx service..."));
      await executor.streamExec(
        plan.startCommand,
        onLog as (log: LogEntry) => void,
      );
    }

    // Ensure sites-enabled directory exists
    await executor.mkdir("/etc/nginx/sites-enabled");

    onLog(log("Verifying Nginx installation..."));
    const version = await executor.exec(plan.verifyCommand);
    const parsed = systemCatalog.checks.nginx.parseVersion(version);

    onLog(log(`Nginx ${parsed} installed with certbot`));
    return { component: "nginx", success: true, version: parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog(log(`Nginx installation failed: ${msg}`, "error"));
    return { component: "nginx", success: false, error: msg };
  }
}

export async function installCertbot(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const profile = await resolveEnvironment(executor);
  const plan = systemCatalog.installs.certbot(profile);
  if (!plan.supported || !plan.installCommand || !plan.verifyCommand) {
    return {
      component: "certbot",
      success: false,
      error: plan.unsupportedReason ?? "Certbot installation is not supported on this environment",
    };
  }

  onLog(log("Installing certbot..."));

  try {
    const { code } = await executor.streamExec(
      plan.installCommand,
      onLog as (log: LogEntry) => void,
    );
    if (code !== 0) {
      return { component: "certbot", success: false, error: "Certbot installation failed" };
    }

    onLog(log("Verifying certbot installation..."));
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

// ─── Registry ────────────────────────────────────────────────────────────────

type InstallerFn = (
  executor: CommandExecutor,
  onLog: SystemLogCallback,
  config?: InstallerConfig,
) => Promise<InstallResult>;

/** All available component installers, keyed by component name. */
export const COMPONENT_INSTALLERS: Record<string, InstallerFn> = {
  docker: (exec, log) => installDocker(exec, log),
  nginx: (exec, log) => installNginx(exec, log),
  certbot: (exec, log) => installCertbot(exec, log),
  git: (exec, log) => installGit(exec, log),
  rsync: (exec, log) => installRsync(exec, log),
};
