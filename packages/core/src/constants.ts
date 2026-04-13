/**
 * Shared constants used across the monorepo.
 */

import type { PlanId } from "./types";

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
  // Force color output even without a TTY (exec API uses pipes, not PTY)
  FORCE_COLOR: "1",
  TERM: "xterm-256color",
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

export const ANNUAL_DISCOUNT = 0.2; // 20% off

export const PLANS = {
  free: {
    name: "Free",
    description: "For personal projects and getting started.",
    popular: false,
    price: 0,
    projects: 3,
    deploymentsPerMonth: 50,
    customDomains: 1,
    teamMembers: 1,
    buildMinutes: 100,
    bandwidth: 1, // GB
    support: "community" as const,
    features: [
      "3 projects",
      "50 deployments/mo",
      "1 custom domain",
      "100 build minutes",
      "1 GB bandwidth",
      "Community support",
    ],
  },
  pro: {
    name: "Pro",
    description: "For professionals who need more power.",
    popular: true,
    price: 20,
    projects: 15,
    deploymentsPerMonth: 300,
    customDomains: 5,
    teamMembers: 3,
    buildMinutes: 1000,
    bandwidth: 50, // GB
    support: "priority" as const,
    features: [
      "15 projects",
      "300 deployments/mo",
      "5 custom domains",
      "1,000 build minutes",
      "50 GB bandwidth",
      "3 team members",
      "Priority support",
    ],
  },
  team: {
    name: "Team",
    description: "For teams shipping at scale.",
    popular: false,
    price: 50,
    projects: 50,
    deploymentsPerMonth: 1000,
    customDomains: 20,
    teamMembers: 15,
    buildMinutes: 5000,
    bandwidth: 250, // GB
    support: "dedicated" as const,
    features: [
      "50 projects",
      "1,000 deployments/mo",
      "20 custom domains",
      "5,000 build minutes",
      "250 GB bandwidth",
      "15 team members",
      "Dedicated support",
      "SSO / SAML",
    ],
  },
} as const;

/** Ordered list of plan IDs for display. */
export const PLAN_IDS: readonly PlanId[] = ["free", "pro", "team"] as const;
