import type { CommandExecutor } from "../types";
import { formatDuration, systemDebug } from "./debug";
import { isRemoteConnectionError } from "./errors";

export type SystemOs = "linux" | "darwin" | "unknown";
export type SystemArch = "amd64" | "arm64" | "unknown";
export type SystemPackageManager = "apt" | "dnf" | "yum" | "brew" | "none";
export type SystemServiceManager = "systemd" | "launchd" | "none";
export type LinuxDistro =
  | "ubuntu"
  | "debian"
  | "fedora"
  | "rhel"
  | "centos"
  | "alpine"
  | "unknown";

export interface EnvironmentProfile {
  os: SystemOs;
  arch: SystemArch;
  distro: LinuxDistro | null;
  packageManager: SystemPackageManager;
  serviceManager: SystemServiceManager;
}

const profileCache = new WeakMap<CommandExecutor, Promise<EnvironmentProfile>>();

async function execSafe(
  executor: CommandExecutor,
  command: string,
  timeout = 5_000,
): Promise<string | null> {
  const startedAt = Date.now();
  systemDebug("environment", `exec:start ${command}`);
  try {
    const result = await executor.exec(command, { timeout });
    systemDebug(
      "environment",
      `exec:ok ${command} (${formatDuration(startedAt)})`,
    );
    return result;
  } catch (err) {
    if (isRemoteConnectionError(err)) {
      systemDebug(
        "environment",
        `exec:abort ${command} (${formatDuration(startedAt)}) ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    systemDebug(
      "environment",
      `exec:fail ${command} (${formatDuration(startedAt)}) ${msg}`,
    );
    return null;
  }
}

function parseOs(uname: string | null): SystemOs {
  const value = uname?.trim().toLowerCase();
  if (value === "linux") return "linux";
  if (value === "darwin") return "darwin";
  return "unknown";
}

function parseArch(uname: string | null): SystemArch {
  const value = uname?.trim().toLowerCase() ?? "";
  if (["x86_64", "amd64"].includes(value)) return "amd64";
  if (["aarch64", "arm64"].includes(value)) return "arm64";
  return "unknown";
}

function parseDistro(osRelease: string | null): LinuxDistro | null {
  if (!osRelease) return null;

  const lower = osRelease.toLowerCase();
  const match = lower.match(/^id=(.+)$/m);
  const id = match?.[1]?.replaceAll('"', "").trim();

  switch (id) {
    case "ubuntu":
      return "ubuntu";
    case "debian":
      return "debian";
    case "fedora":
      return "fedora";
    case "rhel":
    case "rhel server":
      return "rhel";
    case "centos":
      return "centos";
    case "alpine":
      return "alpine";
    default:
      return "unknown";
  }
}

async function detectPackageManager(
  executor: CommandExecutor,
): Promise<SystemPackageManager> {
  const checks: Array<[SystemPackageManager, string]> = [
    ["apt", "command -v apt-get"],
    ["dnf", "command -v dnf"],
    ["yum", "command -v yum"],
    ["brew", "command -v brew"],
  ];

  for (const [pm, command] of checks) {
    if (await execSafe(executor, command)) return pm;
  }

  return "none";
}

async function detectServiceManager(
  executor: CommandExecutor,
): Promise<SystemServiceManager> {
  if (await execSafe(executor, "command -v systemctl")) return "systemd";
  if (await execSafe(executor, "command -v launchctl")) return "launchd";
  return "none";
}

async function detectProfile(
  executor: CommandExecutor,
): Promise<EnvironmentProfile> {
  const startedAt = Date.now();
  systemDebug("environment", "detect:start");
  const [unameOs, unameArch, osRelease, packageManager, serviceManager] =
    await Promise.all([
      execSafe(executor, "uname -s"),
      execSafe(executor, "uname -m"),
      execSafe(executor, "cat /etc/os-release"),
      detectPackageManager(executor),
      detectServiceManager(executor),
    ]);

  const os = parseOs(unameOs);

  const profile = {
    os,
    arch: parseArch(unameArch),
    distro: os === "linux" ? parseDistro(osRelease) : null,
    packageManager,
    serviceManager,
  };

  systemDebug(
    "environment",
    `detect:done (${formatDuration(startedAt)}) ${JSON.stringify(profile)}`,
  );

  return profile;
}

export async function resolveEnvironment(
  executor: CommandExecutor,
): Promise<EnvironmentProfile> {
  let promise = profileCache.get(executor);
  if (!promise) {
    systemDebug("environment", "cache:miss");
    promise = detectProfile(executor);
    profileCache.set(executor, promise);
  } else {
    systemDebug("environment", "cache:hit");
  }
  return promise;
}