import { env, runtimeTarget } from "../../config/env";

export interface CloudAnalyticsConfig {
  key: string;
  host: string;
  dashboardOrigin: string;
  excludedOrganizations: ReadonlySet<string>;
  excludedUsers: ReadonlySet<string>;
}

export function resolveCloudAnalyticsConfig(
  input: {
    CLOUD_MODE?: boolean;
    NODE_ENV?: string;
    DEPLOY_MODE?: string;
    POSTHOG_ENABLED?: boolean;
    POSTHOG_PROJECT_KEY?: string;
    POSTHOG_HOST?: string;
    POSTHOG_EXCLUDED_ORGANIZATION_IDS?: string;
    POSTHOG_EXCLUDED_USER_IDS?: string;
  },
  dashboard: string,
): CloudAnalyticsConfig | null {
  if (
    input.CLOUD_MODE !== true ||
    input.NODE_ENV !== "production" ||
    input.DEPLOY_MODE === "desktop" ||
    input.POSTHOG_ENABLED !== true
  )
    return null;
  const key = input.POSTHOG_PROJECT_KEY?.trim();
  const host = input.POSTHOG_HOST?.replace(/\/+$/, "") ?? "https://us.i.posthog.com";
  // No arbitrary outbound destination or accidental personal API key.
  if (
    !key ||
    !/^phc_[A-Za-z0-9]+$/.test(key) ||
    !["https://us.i.posthog.com", "https://eu.i.posthog.com"].includes(host)
  )
    return null;
  let origin: URL;
  try {
    origin = new URL(dashboard);
  } catch {
    return null;
  }
  if (origin.protocol !== "https:" || origin.username || origin.password) return null;
  const ids = (value?: string) =>
    new Set(
      value
        ?.split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    );
  return {
    key,
    host,
    dashboardOrigin: origin.origin,
    excludedOrganizations: ids(input.POSTHOG_EXCLUDED_ORGANIZATION_IDS),
    excludedUsers: ids(input.POSTHOG_EXCLUDED_USER_IDS),
  };
}

export function getCloudAnalyticsConfig(): CloudAnalyticsConfig | null {
  if (
    env.CLOUD_MODE !== true ||
    env.NODE_ENV !== "production" ||
    env.POSTHOG_ENABLED !== true ||
    env.DEPLOY_MODE === "desktop"
  )
    return null;
  return resolveCloudAnalyticsConfig(env, runtimeTarget.dashboard);
}
