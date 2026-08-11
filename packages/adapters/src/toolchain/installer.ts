/**
 * Toolchain installers - install language runtimes on bare metal.
 *
 * Same pattern as system/installer.ts:
 *   1. Resolve environment profile (OS, arch, package manager)
 *   2. Get install plan from catalog
 *   3. Stream the install command output
 *   4. Verify installation
 *
 * Installs run sequentially - dependencies first (e.g. ruby before bundler).
 * Tools with `providedBy` are skipped if their parent was just installed.
 */

import type { CommandExecutor, LogEntry } from "../types";
import type { ToolchainInstallResult, ToolStep, ToolStepUser } from "./types";
import { toolchainCatalog } from "./catalog";
import { checkTool, meetsMinVersion } from "./checks";
import { resolveEnvironment } from "../system/environment";
import { envOps, opScript } from "../system/environment-ops";
import { privilegedExecutor } from "../system/privilege";
import { systemDebug, formatDuration } from "../system/debug";
import { safeErrorMessage } from "@repo/core";

// ─── Step authority ─────────────────────────────────────────────────────────

interface StepGroup {
  readonly as: ToolStepUser;
  readonly commands: readonly string[];
}

/**
 * Consecutive steps sharing an authority become one `&&`-joined script.
 *
 * Grouped rather than one exec per step because `&&` is what makes a failed step abort
 * the rest — the alternative is `apt-get update` failing and `apt-get install` then
 * "succeeding" against a stale index. Thirteen of the fifteen recipes are uniform, so
 * they stay a single round-trip; bun and rustc become two.
 *
 * `hostNeedsRoot` collapses `"root"` to `"login"` on a host where elevation is wrong
 * rather than merely unnecessary: on macOS the target is the operator's own machine and
 * Homebrew refuses to run under sudo. `"login"` is never promoted — it is a hard
 * constraint, not a preference.
 */
export function groupStepsByAuthority(
  steps: readonly ToolStep[],
  hostNeedsRoot: boolean,
): readonly StepGroup[] {
  const groups: { as: ToolStepUser; commands: string[] }[] = [];
  for (const step of steps) {
    const as: ToolStepUser = step.as === "root" && hostNeedsRoot ? "root" : "login";
    const open = groups.at(-1);
    if (open && open.as === as) open.commands.push(step.command);
    else groups.push({ as, commands: [step.command] });
  }
  return groups;
}

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
    onLog?.({
      timestamp: new Date().toISOString(),
      message: `Cannot install ${recipe.label} on ${envOps(profile).describe()}: ${plan.reason}`,
      level: "error",
    });
    return { tool: name, success: false, error: plan.reason };
  }

  const groups = groupStepsByAuthority(plan.value.steps, envOps(profile).installsNeedRoot());

  // A `"root"` step writes outside the login user's own space (a package manager, or a
  // symlink into /usr/local/bin), so it needs the same gate the system components use.
  // Skipping it is why every toolchain install failed on a non-root host — as an
  // "install failed", never as "this login isn't privileged".
  //
  // Resolved once for the whole install and only if some step needs it, so a
  // login-only recipe on an unprivileged host is not refused for a grant it never uses.
  let elevated: CommandExecutor | null = null;
  if (groups.some((group) => group.as === "root")) {
    const grant = await privilegedExecutor(executor, `Installing ${recipe.label}`);
    if (!grant.supported) {
      onLog?.({
        timestamp: new Date().toISOString(),
        message: grant.reason,
        level: "error",
      });
      return { tool: name, success: false, error: grant.reason };
    }
    elevated = grant.value.executor;
  }

  systemDebug("toolchain", `install:start ${name}`);
  onLog?.({
    timestamp: new Date().toISOString(),
    message: `Installing ${recipe.label}...`,
    level: "info",
  });

  try {
    for (const group of groups) {
      // `elevated` is non-null whenever a group asks for root — the loop above resolved
      // the grant or returned. Falling back to `executor` would silently run a root step
      // unprivileged, which is the class of bug this whole path exists to remove.
      const runner = group.as === "root" ? elevated! : executor;
      const { code } = await runner.streamExec(opScript(group.commands), (entry) => {
        onLog?.(entry);
      });

      if (code !== 0) {
        throw new Error(`Install command failed with exit code ${code}`);
      }
    }

    // Deliberately the RAW executor, never `installer`: the tool has to be on PATH for
    // whoever actually builds with it. Verifying as root would pass on a $HOME recipe
    // that landed in /root and is unreachable for the login user.
    const verifyResult = await executor
      .exec(plan.value.verifyCommand, { timeout: 10_000 })
      .catch(() => null);

    if (!verifyResult) {
      throw new Error(`${recipe.label} installed but verification failed`);
    }

    const version = recipe.parseVersion(verifyResult);

    // `requiredVersion` arrived from the stack's floor and was then ignored, so a distro
    // package a major behind it — Alpine's nodejs 18 against a stack asking for 20.9 —
    // was reported as a successful install and the build failed later on syntax the
    // runtime did not have. The same bar `checkTool` already holds a pre-existing install
    // to, applied to one we just performed.
    if (requiredVersion && !meetsMinVersion(version, requiredVersion)) {
      throw new Error(
        `${recipe.label} ${version} was installed but this project needs ` +
          `${requiredVersion} or newer, and this host has no newer package. Use a newer ` +
          `OS release, or build in a container.`,
      );
    }

    systemDebug("toolchain", `install:done ${name} v${version} (${formatDuration(startedAt)})`);

    onLog?.({
      timestamp: new Date().toISOString(),
      message: `${recipe.label} ${version} installed successfully`,
      level: "info",
    });

    return { tool: name, success: true, version };
  } catch (err) {
    const msg = safeErrorMessage(err);
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
