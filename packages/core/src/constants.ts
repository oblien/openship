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

export const FRAMEWORKS = ["nextjs", "node", "static", "docker"] as const;

export const PLANS = {
  free: { name: "Free", price: 0, buildMinutes: 100, bandwidth: 1 },
  pro: { name: "Pro", price: 20, buildMinutes: 1000, bandwidth: 100 },
  team: { name: "Team", price: 50, buildMinutes: 5000, bandwidth: 500 },
} as const;
