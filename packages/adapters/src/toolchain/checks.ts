/**
 * Toolchain health checks — detect installed language runtimes.
 *
 * Same pattern as system/checks.ts but for language-specific tools.
 * All checks run through CommandExecutor — works local + SSH.
 * Checks are fast, non-destructive, and run in parallel.
 */

import { LANGUAGES, STACKS, type Language, type StackId } from "@repo/core";
import type { CommandExecutor } from "../types";
import type { ToolchainStatus, ToolchainCheckResult } from "./types";
import { toolchainCatalog } from "./catalog";
import { formatDuration, systemDebug } from "../system/debug";
import { isRemoteConnectionError } from "../system/errors";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Run a command via executor, return stdout or null on failure. */
async function tryExec(
  executor: CommandExecutor,
  command: string,
): Promise<string | null> {
  const startedAt = Date.now();
  systemDebug("toolchain", `exec:start ${command}`);
  try {
    const result = await executor.exec(command, { timeout: 10_000 });
    systemDebug(
      "toolchain",
      `exec:ok ${command} (${formatDuration(startedAt)})`,
    );
    return result;
  } catch (err) {
    if (isRemoteConnectionError(err)) {
      systemDebug(
        "toolchain",
        `exec:abort ${command} (${formatDuration(startedAt)}) ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    systemDebug(
      "toolchain",
      `exec:fail ${command} (${formatDuration(startedAt)}) ${msg}`,
    );
    return null;
  }
}

// ─── Single tool check ──────────────────────────────────────────────────────

/** Check a single tool — returns its status. */
export async function checkTool(
  executor: CommandExecutor,
  name: string,
): Promise<ToolchainStatus> {
  const recipe = toolchainCatalog.checks[name];
  if (!recipe) {
    return {
      name,
      label: name,
      installed: false,
      healthy: false,
      message: `Unknown tool: ${name}`,
    };
  }

  const output = await tryExec(executor, recipe.versionCommand);
  if (!output) {
    systemDebug("toolchain", `${name}:missing`);
    return {
      name,
      label: recipe.label,
      installed: false,
      healthy: false,
      message: recipe.missingMessage,
    };
  }

  const version = recipe.parseVersion(output);
  systemDebug("toolchain", `${name}:healthy v${version}`);
  return {
    name,
    label: recipe.label,
    installed: true,
    version,
    healthy: true,
    message: `${recipe.label} ${version}`,
  };
}

// ─── Batch checks ───────────────────────────────────────────────────────────

/** Check a specific list of tools in parallel. */
export async function checkTools(
  executor: CommandExecutor,
  toolNames: readonly string[],
): Promise<ToolchainCheckResult> {
  const startedAt = Date.now();
  systemDebug("toolchain", `checkTools:start [${toolNames.join(", ")}]`);

  const tools = await Promise.all(
    toolNames.map((name) => checkTool(executor, name)),
  );

  const missing = tools.filter((t) => !t.healthy).map((t) => t.name);
  const ready = missing.length === 0;

  systemDebug(
    "toolchain",
    `checkTools:done (${formatDuration(startedAt)}) ready=${ready} missing=[${missing.join(", ")}]`,
  );

  return { tools, ready, missing };
}

/** Resolve required tools from a language, then check them all. */
export async function checkToolchain(
  executor: CommandExecutor,
  language: Language,
): Promise<ToolchainCheckResult> {
  const lang = LANGUAGES[language];
  if (!lang || lang.requiredTools.length === 0) {
    return { tools: [], ready: true, missing: [] };
  }

  return checkTools(executor, lang.requiredTools);
}

/** Resolve required tools from a stack ID, then check them all. */
export async function checkToolchainForStack(
  executor: CommandExecutor,
  stackId: string,
): Promise<ToolchainCheckResult> {
  const stack = STACKS[stackId as StackId];
  if (!stack) {
    return { tools: [], ready: true, missing: [] };
  }

  return checkToolchain(executor, stack.language);
}
