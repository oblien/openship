/**
 * Toolchain installers — install language runtimes on bare metal.
 *
 * Same pattern as system/installer.ts:
 *   1. Resolve environment profile (OS, arch, package manager)
 *   2. Get install plan from catalog
 *   3. Stream the install command output
 *   4. Verify installation
 *
 * Installs run sequentially — dependencies first (e.g. ruby before bundler).
 * Tools with `providedBy` are skipped if their parent was just installed.
 */

import type { CommandExecutor, LogEntry } from "../types";
import type { ToolchainInstallResult } from "./types";
import { toolchainCatalog } from "./catalog";
import { checkTool } from "./checks";
import { resolveEnvironment } from "../system/environment";
import { systemDebug, formatDuration } from "../system/debug";

// ─── Single tool install ────────────────────────────────────────────────────

/**
 * Install a single tool. Streams output via onLog callback.
 * Returns the install result (success/failure + version).
 */
export async function installTool(
  executor: CommandExecutor,
  name: string,
  onLog?: (log: LogEntry) => void,
  requiredVersion?: string,
): Promise<ToolchainInstallResult> {
  const startedAt = Date.now();
  const recipe = toolchainCatalog.checks[name];

  if (!recipe) {
    return { tool: name, success: false, error: `Unknown tool: ${name}` };
  }

  // If tool is provided by a parent, check if it's already available
  // (parent install may have brought it in)
  if (recipe.providedBy && !toolchainCatalog.installs[name]) {
    const status = await checkTool(executor, name, { minVersion: requiredVersion });
    if (status.healthy) {
      return { tool: name, success: true, version: status.version };
    }
    return {
      tool: name,
      success: false,
      error: `${recipe.label} should be installed by ${recipe.providedBy}`,
    };
  }

  const factory = toolchainCatalog.installs[name];
  if (!factory) {
    return { tool: name, success: false, error: `No installer for ${name}` };
  }

  const profile = await resolveEnvironment(executor);
  const plan = factory(profile);

  if (!plan.supported) {
    const msg = plan.unsupportedReason ?? `${recipe.label} installation not supported on this system`;
    onLog?.({
      timestamp: new Date().toISOString(),
      message: msg,
      level: "error",
    });
    return { tool: name, success: false, error: msg };
  }

  systemDebug("toolchain", `install:start ${name}`);
  onLog?.({
    timestamp: new Date().toISOString(),
    message: `Installing ${recipe.label}...`,
    level: "info",
  });

  try {
    // Run the install command with streaming output
    const { code } = await executor.streamExec(plan.installCommand!, (entry) => {
      onLog?.(entry);
    });

    if (code !== 0) {
      // Try fallback commands if available
      if (plan.fallbackInstallCommands?.length) {
        for (const fallback of plan.fallbackInstallCommands) {
          onLog?.({
            timestamp: new Date().toISOString(),
            message: `Primary install failed, trying fallback...`,
            level: "warn",
          });
          const fb = await executor.streamExec(fallback, (entry) => onLog?.(entry));
          if (fb.code === 0) break;
        }
      } else {
        throw new Error(`Install command failed with exit code ${code}`);
      }
    }

    // Run start command if needed
    if (plan.startCommand) {
      await executor.streamExec(plan.startCommand, (entry) => onLog?.(entry));
    }

    // Verify installation
    const verifyCmd = plan.verifyCommand ?? recipe.versionCommand;
    const verifyResult = await executor.exec(verifyCmd, { timeout: 10_000 }).catch(() => null);

    if (!verifyResult) {
      throw new Error(`${recipe.label} installed but verification failed`);
    }

    const version = recipe.parseVersion(verifyResult);
    systemDebug("toolchain", `install:done ${name} v${version} (${formatDuration(startedAt)})`);

    onLog?.({
      timestamp: new Date().toISOString(),
      message: `${recipe.label} ${version} installed successfully`,
      level: "info",
    });

    return { tool: name, success: true, version };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    systemDebug("toolchain", `install:fail ${name} (${formatDuration(startedAt)}) ${msg}`);

    onLog?.({
      timestamp: new Date().toISOString(),
      message: `Failed to install ${recipe.label}: ${msg}`,
      level: "error",
    });

    return { tool: name, success: false, error: msg };
  }
}

// ─── Batch install ──────────────────────────────────────────────────────────

/**
 * Install multiple tools sequentially. Respects dependency order:
 * parent tools (node, ruby, python3) are installed before their
 * children (npm, bundler, pip).
 *
 * Returns results for each tool.
 */
export async function installTools(
  executor: CommandExecutor,
  toolNames: readonly string[],
  onLog?: (log: LogEntry) => void,
  requiredVersions?: Readonly<Record<string, string>>,
): Promise<ToolchainInstallResult[]> {
  // Sort: parent tools first, children after
  const sorted = [...toolNames].sort((a, b) => {
    const aEntry = toolchainCatalog.checks[a];
    const bEntry = toolchainCatalog.checks[b];
    // Tools with providedBy go after their parent
    if (aEntry?.providedBy === b) return 1;
    if (bEntry?.providedBy === a) return -1;
    // Installable tools first
    if (aEntry?.installable && !bEntry?.installable) return -1;
    if (!aEntry?.installable && bEntry?.installable) return 1;
    return 0;
  });

  const results: ToolchainInstallResult[] = [];

  for (const name of sorted) {
    // Skip if already healthy (e.g. parent install brought it in)
    const status = await checkTool(executor, name, {
      minVersion: requiredVersions?.[name],
    });
    if (status.healthy) {
      onLog?.({
        timestamp: new Date().toISOString(),
        message: `${status.label} ${status.version ?? ""} already installed, skipping`,
        level: "info",
      });
      results.push({ tool: name, success: true, version: status.version });
      continue;
    }

    const result = await installTool(executor, name, onLog, requiredVersions?.[name]);
    results.push(result);
  }

  return results;
}
