/**
 * Shared constants used across the monorepo.
 */

export const APP_NAME = "Openship";

export const DEFAULT_PORT = {
  web: 3000,
  dashboard: 3001,
  api: 4000,
} as const;

export const DEPLOYMENT_STATUSES = [
  "queued",
  "building",
  "deploying",
  "ready",
  "failed",
  "cancelled",
] as const;

/**
 * Re-export from stacks registry — STACK_IDS replaces the old FRAMEWORKS array.
 * Import { STACK_IDS } or { STACKS } from "@repo/core" instead.
 */
export { STACK_IDS as FRAMEWORKS } from "./stacks";

export const PRODUCTION_MODES = ["host", "static", "standalone"] as const;

export const ENVIRONMENTS = ["production", "preview", "development"] as const;

export const DOMAIN_STATUSES = ["pending", "active", "failed", "removing"] as const;

export const SSL_STATUSES = ["none", "provisioning", "active", "expired", "error"] as const;

/**
 * Non-interactive environment variables injected into every build container.
 * Prevents interactive prompts and disables telemetry during CI builds.
 */
export const BUILD_ENV_VARS: Record<string, string> = {
  CI: "true",
  DEBIAN_FRONTEND: "noninteractive",
  // Framework telemetry
  NG_CLI_ANALYTICS: "false",
  NEXT_TELEMETRY_DISABLED: "1",
  NUXT_TELEMETRY_DISABLED: "1",
  ASTRO_TELEMETRY_DISABLED: "1",
  GATSBY_TELEMETRY_DISABLED: "1",
  DO_NOT_TRACK: "1",
  // Package manager
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false",
  YARN_ENABLE_TELEMETRY: "0",
  PNPM_NO_UPDATE_NOTIFIER: "true",
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * Re-export from stacks registry — OUTPUT_DIRECTORIES is derived from STACKS.
 */
export { OUTPUT_DIRECTORIES } from "./stacks";

export const PLANS = {
  free: { name: "Free", price: 0, buildMinutes: 100, bandwidth: 1 },
  pro: { name: "Pro", price: 20, buildMinutes: 1000, bandwidth: 100 },
  team: { name: "Team", price: 50, buildMinutes: 5000, bandwidth: 500 },
} as const;
