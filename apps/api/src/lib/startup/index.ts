/**
 * Startup-hooks registry — Self-hosted only (never SaaS).
 *
 * A clean home for features that need to run something once at API boot
 * (e.g. re-establishing desktop port-forward tunnels). A feature registers a
 * hook from its own module; `runStartupHooks()` is invoked once from app.ts
 * after the platform is initialized.
 *
 * ── Mode-tagging convention (documented here, applied as a JSDoc header on
 *    each mode-scoped file across the codebase) ──────────────────────────────
 *   - "Cloud/SaaS-only."   → runs only under CLOUD_MODE / platform target "cloud"
 *   - "Self-hosted only."  → never in SaaS (CLOUD_MODE off)
 *   - "Desktop-only."      → only when platform target === "desktop"
 *
 * This whole module is self-hosted: `runStartupHooks()` is a no-op under
 * CLOUD_MODE and skips any hook whose `modes` don't include the live target.
 */
import { env } from "../../config/env";
import { resolvePlatformConfig } from "../controller-helpers";

/** Non-cloud platform targets a hook may opt into. */
export type StartupMode = "selfhosted" | "desktop";

export interface StartupHook {
  /** Stable id, used only for logging. */
  id: string;
  /** Platform targets this hook runs under. */
  modes: StartupMode[];
  /** The boot work. Errors are caught + logged, never fatal to boot. */
  run: () => Promise<void>;
}

const hooks: StartupHook[] = [];

/** Register a startup hook. Called from a feature's registration fn. */
export function registerStartupHook(hook: StartupHook): void {
  hooks.push(hook);
}

/**
 * Run every registered hook whose `modes` include the current target.
 *
 * No-op under CLOUD_MODE (and for target "cloud"). Best-effort: a failing
 * hook is logged and skipped, never aborts boot.
 */
export async function runStartupHooks(): Promise<void> {
  if (env.CLOUD_MODE) return; // self-hosted only — never SaaS

  const target = resolvePlatformConfig().target;

  for (const hook of hooks) {
    if (!hook.modes.includes(target)) continue;
    try {
      await hook.run();
    } catch (err) {
      console.warn(`[startup] hook "${hook.id}" failed:`, err);
    }
  }
}
