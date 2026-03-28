/**
 * Shared compose domain/subdomain helpers.
 *
 * Used by both the compose pipeline (route registration after deploy)
 * and the preflight checks (domain validation before build).
 */

import { defaultServiceHostnameLabel, normalizeServiceLabel } from "@repo/core";

/** Normalize a string into a valid DNS subdomain label. */
export function normalizeSubdomain(value: string): string {
  return normalizeServiceLabel(value);
}

/** Default subdomain for a compose service: `<project>` for web/app/frontend, `<project>-<service>` otherwise. */
export function defaultServiceSubdomain(projectSlug: string, serviceName: string): string {
  return defaultServiceHostnameLabel(projectSlug, serviceName);
}

/** Parse the last port number from a port spec string (e.g. "8080:3000/tcp" → 3000). */
export function parseServicePort(value?: string): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const last = trimmed.split(":").pop()?.split("/")[0]?.trim();
  const port = Number(last);
  return Number.isFinite(port) && port > 0 ? port : null;
}
