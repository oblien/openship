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
  onLog(log("Installing Docker Engine via official script..."));

  try {
    const { code } = await executor.streamExec(
      "curl -fsSL https://get.docker.com | sh",
      onLog as (log: LogEntry) => void,
    );
    if (code !== 0) {
      return { component: "docker", success: false, error: "Docker install script failed" };
    }

    onLog(log("Enabling and starting Docker service..."));
    await executor.streamExec(
      "systemctl enable docker && systemctl start docker",
      onLog as (log: LogEntry) => void,
    );

    onLog(log("Verifying Docker installation..."));
    const version = await executor.exec("docker --version");
    const parsed = version.match(/Docker version ([^\s,]+)/)?.[1] ?? version;

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

  try {
    if (mode === "docker") {
      return await installTraefikDocker(executor, onLog, config);
    }
    return await installTraefikBinary(executor, onLog);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog(log(`Traefik installation failed: ${msg}`, "error"));
    return { component: "traefik", success: false, error: msg };
  }
}

async function installTraefikDocker(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
  config?: InstallerConfig,
): Promise<InstallResult> {
  const acmeEmail = config?.acmeEmail ?? "admin@localhost";
  if (config?.acmeEmail && !isValidEmail(config.acmeEmail)) {
    return { component: "traefik", success: false, error: "Invalid ACME email" };
  }

  onLog(log("Pulling Traefik Docker image..."));
  const { code } = await executor.streamExec(
    "docker pull traefik:v3.4",
    onLog as (log: LogEntry) => void,
  );
  if (code !== 0) {
    return { component: "traefik", success: false, error: "Failed to pull Traefik image" };
  }

  onLog(log("Creating Traefik configuration directories..."));
  await executor.mkdir("/etc/traefik/dynamic");
  await executor.mkdir("/etc/traefik/acme");

  onLog(log("Starting Traefik container..."));
  const args = [
    "docker run -d",
    "--name traefik",
    "--restart unless-stopped",
    "--network host",
    "-v /var/run/docker.sock:/var/run/docker.sock:ro",
    "-v /etc/traefik:/etc/traefik",
    "traefik:v3.4",
    "--providers.file.directory=/etc/traefik/dynamic",
    "--providers.file.watch=true",
    "--entrypoints.web.address=:80",
    "--entrypoints.websecure.address=:443",
    `--certificatesresolvers.letsencrypt.acme.email=${acmeEmail}`,
    "--certificatesresolvers.letsencrypt.acme.storage=/etc/traefik/acme/acme.json",
    "--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web",
  ];

  const { code: runCode } = await executor.streamExec(
    args.join(" "),
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
): Promise<InstallResult> {
  onLog(log("Downloading Traefik binary..."));

  // Detect architecture on the target machine
  let arch: string;
  try {
    const uname = await executor.exec("uname -m");
    arch = uname.includes("aarch64") || uname.includes("arm64") ? "arm64" : "amd64";
  } catch {
    arch = "amd64";
  }

  const url = `https://github.com/traefik/traefik/releases/latest/download/traefik_linux_${arch}`;

  const { code } = await executor.streamExec(
    `curl -fsSL -o /tmp/traefik "${url}" && chmod +x /tmp/traefik && mv /tmp/traefik /usr/local/bin/traefik`,
    onLog as (log: LogEntry) => void,
  );
  if (code !== 0) {
    return { component: "traefik", success: false, error: "Failed to download Traefik binary" };
  }

  let version = "unknown";
  try {
    version = await executor.exec("traefik version 2>/dev/null || echo unknown");
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
  onLog(log("Installing Git..."));

  try {
    const pm = await detectPackageManager(executor);

    const commands: Record<string, string> = {
      apt: "apt-get update -qq && apt-get install -y -qq git",
      dnf: "dnf install -y git",
      yum: "yum install -y git",
      brew: "brew install git",
    };

    if (!pm || !commands[pm]) {
      return { component: "git", success: false, error: "No supported package manager found" };
    }

    const { code } = await executor.streamExec(
      commands[pm],
      onLog as (log: LogEntry) => void,
    );
    if (code !== 0) {
      return { component: "git", success: false, error: "Git installation failed" };
    }

    const version = await executor.exec("git --version");
    const parsed = version.match(/git version (\S+)/)?.[1] ?? version;

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
  onLog(log("Installing Node.js (LTS)..."));

  try {
    const { code } = await executor.streamExec(
      "curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs",
      onLog as (log: LogEntry) => void,
    );

    if (code !== 0) {
      const pm = await detectPackageManager(executor);
      if (pm === "brew") {
        await executor.streamExec("brew install node", onLog as (log: LogEntry) => void);
      } else if (pm === "dnf" || pm === "yum") {
        await executor.streamExec(
          `${pm} install -y nodejs`,
          onLog as (log: LogEntry) => void,
        );
      } else {
        return { component: "node", success: false, error: "Node.js installation failed" };
      }
    }

    const version = await executor.exec("node --version");
    const parsed = version.replace(/^v/, "");

    onLog(log(`Node.js ${parsed} installed`));
    return { component: "node", success: true, version: parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog(log(`Node.js installation failed: ${msg}`, "error"));
    return { component: "node", success: false, error: msg };
  }
}

// ─── Bun ─────────────────────────────────────────────────────────────────────

export async function installBun(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  onLog(log("Installing Bun..."));

  try {
    const { code } = await executor.streamExec(
      "curl -fsSL https://bun.sh/install | bash",
      onLog as (log: LogEntry) => void,
    );
    if (code !== 0) {
      return { component: "bun", success: false, error: "Bun installation failed" };
    }

    let version = "unknown";
    try {
      version = await executor.exec("bun --version");
    } catch {
      // keep "unknown"
    }

    onLog(log(`Bun ${version} installed`));
    return { component: "bun", success: true, version };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog(log(`Bun installation failed: ${msg}`, "error"));
    return { component: "bun", success: false, error: msg };
  }
}

// ─── Package manager detection ───────────────────────────────────────────────

async function detectPackageManager(
  executor: CommandExecutor,
): Promise<"apt" | "dnf" | "yum" | "brew" | null> {
  for (const pm of ["apt", "dnf", "yum", "brew"] as const) {
    try {
      await executor.exec(`command -v ${pm}`, { timeout: 5_000 });
      return pm;
    } catch {
      continue;
    }
  }
  return null;
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
  bun: (exec, log) => installBun(exec, log),
};
