/**
 * Toolchain layer barrel exports.
 *
 * Stack-level tool validation and installation for bare-metal builds.
 * Ensures language runtimes (Node, Go, Rust, Python, etc.) are present
 * before a build starts.
 *
 * Usage:
 *   import { checkToolchainForStack, installTools } from "./toolchain";
 *
 *   const result = await checkToolchainForStack(executor, "nextjs");
 *   if (!result.ready) {
 *     await installTools(executor, result.missing, onLog);
 *   }
 */

// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  ToolchainStatus,
  ToolchainCheckResult,
  ToolchainCheckEntry,
  ToolchainInstallPlan,
  ToolchainInstallResult,
} from "./types";

// ─── Catalog ─────────────────────────────────────────────────────────────────
export { toolchainCatalog } from "./catalog";

// ─── Checks ──────────────────────────────────────────────────────────────────
export {
  checkTool,
  checkTools,
  checkToolchain,
  checkToolchainForStack,
} from "./checks";

// ─── Installers ──────────────────────────────────────────────────────────────
export { installTool, installTools } from "./installer";
