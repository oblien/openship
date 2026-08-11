import type { CommandExecutor } from "../types";
import { formatDuration, systemDebug } from "./debug";
import { isRemoteConnectionError } from "./errors";
import { safeErrorMessage } from "@repo/core";

export type SystemOs = "linux" | "darwin" | "unknown";
export type SystemArch = "amd64" | "arm64" | "unknown";
export type SystemPackageManager = "apt" | "dnf" | "yum" | "apk" | "brew" | "none";
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
  /** The SSH/login user is uid 0. Component installs run privileged commands
   *  (apt, systemctl, writes under /etc) that require this — or `canSudo`. */
  isRoot: boolean;
  /** Non-root but has passwordless sudo (`sudo -n true` succeeds). Lets the
   *  installer elevate privileged commands. Meaningless when `isRoot`. */
  canSudo: boolean;
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
        `exec:abort ${command} (${formatDuration(startedAt)}) ${safeErrorMessage(err)}`,
      );
      throw err;
    }
    const msg = safeErrorMessage(err);
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
    ["apk", "command -v apk"],
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

/** Detect privilege: is the login user root, and (if not) does it have
 *  passwordless sudo? `sudo -n true` is the canonical non-interactive probe —
 *  it exits 0 only when sudo needs no password. The `|| echo no` keeps the
 *  command's own exit status 0 so execSafe returns the marker either way. */
async function detectPrivilege(
  executor: CommandExecutor,
): Promise<{ isRoot: boolean; canSudo: boolean }> {
  const uid = await execSafe(executor, "id -u");
  const isRoot = uid?.trim() === "0";
  if (isRoot) return { isRoot: true, canSudo: false };

  const sudo = await execSafe(
    executor,
    "sudo -n true 2>/dev/null && echo yes || echo no",
  );
  return { isRoot: false, canSudo: sudo?.trim() === "yes" };
}

async function detectProfile(
  executor: CommandExecutor,
): Promise<EnvironmentProfile> {
  const startedAt = Date.now();
  systemDebug("environment", "detect:start");

  // Run probes sequentially - parallel SSH commands can cascade-fail
  // when one channel error triggers resetConnection() and kills all
  // other in-flight streams on the same SSH connection.
  const unameOs = await execSafe(executor, "uname -s");
  const unameArch = await execSafe(executor, "uname -m");
  const osRelease = await execSafe(executor, "cat /etc/os-release");
  const packageManager = await detectPackageManager(executor);
  const serviceManager = await detectServiceManager(executor);
  const { isRoot, canSudo } = await detectPrivilege(executor);

  const os = parseOs(unameOs);

  const profile = {
    os,
    arch: parseArch(unameArch),
    distro: os === "linux" ? parseDistro(osRelease) : null,
    packageManager,
    serviceManager,
    isRoot,
    canSudo,
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