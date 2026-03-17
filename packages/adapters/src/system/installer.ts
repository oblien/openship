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
import type {
  InstallerConfig,
  InstallResult,
  SystemLogCallback,
  SystemLog,
} from "./types";
import { systemCatalog } from "./catalog";
import { resolveEnvironment } from "./environment";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(
  message: string,
  level: SystemLog["level"] = "info",
): SystemLog {
  return { timestamp: new Date().toISOString(), message, level };
}

/** Validate an email for ACME — basic sanity check. */
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Validate a domain — basic sanity check, no shell-unsafe chars. */
function isValidDomain(domain: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain);
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
      error: plan.unsupportedReason ?? "Docker installation is not supported on this environment",
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

// ─── Traefik ─────────────────────────────────────────────────────────────────

export async function installTraefik(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
  config?: InstallerConfig,
): Promise<InstallResult> {
  const mode = config?.traefikMode ?? "docker";
  const profile = await resolveEnvironment(executor);

  try {
    if (mode === "docker") {
      return await installTraefikDocker(executor, onLog, profile, config);
    }
    return await installTraefikBinary(executor, onLog, profile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog(log(`Traefik installation failed: ${msg}`, "error"));
    return { component: "traefik", success: false, error: msg };
  }
}

async function installTraefikDocker(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
  profile: Awaited<ReturnType<typeof resolveEnvironment>>,
  config?: InstallerConfig,
): Promise<InstallResult> {
  if (config?.acmeEmail && !isValidEmail(config.acmeEmail)) {
    return { component: "traefik", success: false, error: "Invalid ACME email" };
  }

  const plan = systemCatalog.installs.traefikDocker(profile, config);
  if (!plan.supported || !plan.installCommand || !plan.startCommand) {
    return {
      component: "traefik",
      success: false,
      error: plan.unsupportedReason ?? "Traefik Docker installation is not supported on this environment",
    };
  }

  onLog(log("Pulling Traefik Docker image..."));
  const { code } = await executor.streamExec(
    plan.installCommand,
    onLog as (log: LogEntry) => void,
  );
  if (code !== 0) {
    return { component: "traefik", success: false, error: "Failed to pull Traefik image" };
  }

  onLog(log("Creating Traefik configuration directories..."));
  await executor.mkdir("/etc/traefik/dynamic");
  await executor.mkdir("/etc/traefik/acme");

  onLog(log("Starting Traefik container..."));
  const { code: runCode } = await executor.streamExec(
    plan.startCommand,
    onLog as (log: LogEntry) => void,
  );
  if (runCode !== 0) {
    return { component: "traefik", success: false, error: "Failed to start Traefik container" };
  }

  onLog(log("Traefik v3.4 running in Docker"));
  return { component: "traefik", success: true, version: "3.4" };
}

async function installTraefikBinary(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
  profile: Awaited<ReturnType<typeof resolveEnvironment>>,
): Promise<InstallResult> {
  onLog(log("Downloading Traefik binary..."));

  const plan = systemCatalog.installs.traefikBinary(profile);
  if (!plan.supported || !plan.installCommand || !plan.verifyCommand) {
    return {
      component: "traefik",
      success: false,
      error: plan.unsupportedReason ?? "Traefik binary installation is not supported on this environment",
    };
  }

  const { code } = await executor.streamExec(
    plan.installCommand,
    onLog as (log: LogEntry) => void,
  );
  if (code !== 0) {
    return { component: "traefik", success: false, error: "Failed to download Traefik binary" };
  }

  let version = "unknown";
  try {
    version = await executor.exec(plan.verifyCommand);
  } catch {
    // keep "unknown"
  }

  onLog(log(`Traefik ${version} installed to /usr/local/bin`));
  return { component: "traefik", success: true, version };
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

// ─── Node.js ─────────────────────────────────────────────────────────────────

export async function installNode(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const profile = await resolveEnvironment(executor);
  const plan = systemCatalog.installs.node(profile);
  if (!plan.supported || !plan.installCommand || !plan.verifyCommand) {
    return {
      component: "node",
      success: false,
      error: plan.unsupportedReason ?? "Node.js installation is not supported on this environment",
    };
  }

  onLog(log("Installing Node.js (LTS)..."));

  try {
    const { code } = await executor.streamExec(
      plan.installCommand,
      onLog as (log: LogEntry) => void,
    );

    if (code !== 0) {
      if (!plan.fallbackInstallCommands?.length) {
        return { component: "node", success: false, error: "Node.js installation failed" };
      }

      let recovered = false;
      for (const fallback of plan.fallbackInstallCommands) {
        const result = await executor.streamExec(
          fallback,
          onLog as (log: LogEntry) => void,
        );
        if (result.code === 0) {
          recovered = true;
          break;
        }
      }

      if (!recovered) {
        return { component: "node", success: false, error: "Node.js installation failed" };
      }
    }

    const version = await executor.exec(plan.verifyCommand);
    const parsed = systemCatalog.checks.node.parseVersion(version);

    onLog(log(`Node.js ${parsed} installed`));
    return { component: "node", success: true, version: parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog(log(`Node.js installation failed: ${msg}`, "error"));
    return { component: "node", success: false, error: msg };
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
  traefik: installTraefik,
  git: (exec, log) => installGit(exec, log),
  node: (exec, log) => installNode(exec, log),
};
