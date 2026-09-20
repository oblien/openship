/**
 * Toolchain health checks - detect installed language runtimes.
 *
 * Same pattern as system/checks.ts but for language-specific tools.
 * All checks run through CommandExecutor - works local + SSH.
 * Checks are fast, non-destructive, and run in parallel.
 */

import { LANGUAGES, STACKS, type Language, type StackDefinition, type StackId } from "@repo/core";
import type { CommandExecutor } from "../types";
import type { ToolchainStatus, ToolchainCheckResult } from "./types";
import { toolchainCatalog } from "./catalog";
import { formatDuration, systemDebug } from "../system/debug";
import { probeExec, withReason } from "../system/probe-exec";

function parseVersionParts(version: string): number[] {
  const match = version.match(/\d+(?:\.\d+)*/)?.[0] ?? "0";
  return match.split(".").map((part) => parseInt(part, 10) || 0);
}

function compareVersions(actual: string, minimum: string): number {
  const actualParts = parseVersionParts(actual);
  const minimumParts = parseVersionParts(minimum);
  const maxLength = Math.max(actualParts.length, minimumParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const left = actualParts[index] ?? 0;
    const right = minimumParts[index] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }

  return 0;
}

/**
 * Does an installed version satisfy the floor a stack asked for?
 *
 * Exported so the installer can hold a just-finished install to the same bar
 * {@link checkTool} holds a pre-existing one to. It used to check nothing, so a distro
 * package a major behind the stack's floor was reported as a successful install and the
 * build then failed on syntax the runtime didn't have.
 */
export function meetsMinVersion(actual: string, minimum: string): boolean {
  return compareVersions(actual, minimum) >= 0;
}

// ─── Single tool check ──────────────────────────────────────────────────────

/** Check a single tool - returns its status. */
export async function checkTool(
  executor: CommandExecutor,
  name: string,
  opts?: { minVersion?: string },
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

  const probe = await probeExec(executor, recipe.versionCommand, "toolchain");
  if (!probe.output) {
    systemDebug("toolchain", `${name}:missing ${probe.error ?? "exited 0 with no version"}`);
    return {
      name,
      label: recipe.label,
      installed: false,
      healthy: false,
      // A tool that isn't there and a tool whose `--version` was refused ("permission
      // denied", "Command timed out") both land here, and only the second can say why —
      // #408, the same conflation `system/checks.ts` reports its way out of.
      message: withReason(recipe.missingMessage, probe.error),
    };
  }

  const version = recipe.parseVersion(probe.output);

  if (opts?.minVersion && compareVersions(version, opts.minVersion) < 0) {
    systemDebug("toolchain", `${name}:outdated v${version} < ${opts.minVersion}`);
    return {
      name,
      label: recipe.label,
      installed: true,
      version,
      requiredVersion: opts.minVersion,
      healthy: false,
      message: `${recipe.label} ${version} is installed but ${opts.minVersion}+ is required`,
    };
  }

  systemDebug("toolchain", `${name}:healthy v${version}`);
  return {
    name,
    label: recipe.label,
    installed: true,
    version,
    requiredVersion: opts?.minVersion,
    healthy: true,
    message: `${recipe.label} ${version}`,
  };
}

// ─── Batch checks ───────────────────────────────────────────────────────────

/** Check a specific list of tools in parallel. */
export async function checkTools(
  executor: CommandExecutor,
  toolNames: readonly string[],
  requiredVersions?: Readonly<Record<string, string>>,
): Promise<ToolchainCheckResult> {
  const startedAt = Date.now();
  systemDebug("toolchain", `checkTools:start [${toolNames.join(", ")}]`);

  const tools = await Promise.all(
    toolNames.map((name) =>
      checkTool(executor, name, { minVersion: requiredVersions?.[name] }),
    ),
  );

  const missing = tools.filter((t) => !t.installed).map((t) => t.name);
  const outdated = tools.filter((t) => t.installed && !t.healthy).map((t) => t.name);
  const ready = missing.length === 0 && outdated.length === 0;

  systemDebug(
    "toolchain",
    `checkTools:done (${formatDuration(startedAt)}) ready=${ready} missing=[${missing.join(", ")}] outdated=[${outdated.join(", ")}]`,
  );

  return { tools, ready, missing, outdated };
}

/** Resolve required tools from a language, then check them all. */
export async function checkToolchain(
  executor: CommandExecutor,
  language: Language,
  requiredVersions?: Readonly<Record<string, string>>,
): Promise<ToolchainCheckResult> {
  const lang = LANGUAGES[language];
  if (!lang || lang.requiredTools.length === 0) {
    return { tools: [], ready: true, missing: [], outdated: [] };
  }

  return checkTools(executor, lang.requiredTools, requiredVersions);
}

/** Resolve required tools from a stack ID, then check them all. */
export async function checkToolchainForStack(
  executor: CommandExecutor,
  stackId: string,
): Promise<ToolchainCheckResult> {
  const stack = STACKS[stackId as StackId] as StackDefinition | undefined;
  if (!stack) {
    return { tools: [], ready: true, missing: [], outdated: [] };
  }

  // Stacks may override the language tool list (e.g. webmail uses bun rather
  // than node). When set, it replaces - not extends - the language list.
  if (stack.requiredTools && stack.requiredTools.length > 0) {
    return checkTools(executor, stack.requiredTools, stack.requiredToolVersions);
  }

  return checkToolchain(executor, stack.language, stack.requiredToolVersions);
}
