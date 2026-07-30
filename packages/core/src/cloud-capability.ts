/**
 * Single source of truth for "this action requires an Openship Cloud connection".
 *
 * A capability names one cloud-requiring action. Everything else keys off this:
 * the API's `requireCloud(capability)` guard + typed error, the dashboard's
 * capability→prompt copy + `requireCloud` hook, and the wire error codes the
 * client maps back to a capability.
 *
 * This module is intentionally UI- and HTTP-framework-agnostic (no React, no
 * Hono): it holds the capability set, the stable wire codes + HTTP statuses, and
 * the ONE needs-cloud predicate. Human-facing copy lives in the API (server
 * messages) and the dashboard (i18n) — never here.
 */

export type CloudCapability =
  | "cloud-deploy-target"
  | "managed-project-domain"
  | "managed-compose-domains"
  | "cloud-services-catalog"
  | "billing"
  | "migrate-to-cloud"
  | "cloud-pages"
  | "github-cloud-app";

/** Distinct signal for "connected, but the SaaS is transiently unreachable" —
 *  deliberately NOT a `CLOUD_REQUIRED_*` code so a connected user is never told
 *  to reconnect. */
export const CLOUD_UNREACHABLE_CODE = "CLOUD_UNREACHABLE";

/**
 * Canonical per-capability metadata.
 *
 * `code` PRESERVES the wire code each capability already emitted (so no existing
 * client/consumer wire format changes); capabilities that had no prior code get
 * a fresh `CLOUD_REQUIRED_*`. `httpStatus` is the status that capability already
 * returned, so status-branching consumers are unaffected.
 */
export const CLOUD_CAPABILITIES: Record<CloudCapability, { code: string; httpStatus: number }> = {
  "cloud-deploy-target": { code: "CLOUD_REQUIRED_TARGET", httpStatus: 403 },
  "managed-project-domain": { code: "CLOUD_REQUIRED_MANAGED_PROJECT_DOMAIN", httpStatus: 403 },
  "managed-compose-domains": { code: "CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS", httpStatus: 403 },
  "cloud-services-catalog": { code: "CLOUD_REQUIRED_SERVICES", httpStatus: 403 },
  billing: { code: "cloud_not_connected", httpStatus: 403 },
  "migrate-to-cloud": { code: "MIGRATE_TO_CLOUD_NOT_CONNECTED", httpStatus: 412 },
  "cloud-pages": { code: "CLOUD_REQUIRED_PAGES", httpStatus: 403 },
  "github-cloud-app": { code: "CLOUD_REQUIRED_GITHUB_APP", httpStatus: 403 },
};

export const CLOUD_CAPABILITY_KEYS = Object.keys(CLOUD_CAPABILITIES) as CloudCapability[];

/** The wire error code for a capability's "not connected" rejection. */
export function cloudRequiredCode(capability: CloudCapability): string {
  return CLOUD_CAPABILITIES[capability].code;
}

const CODE_TO_CAPABILITY: Record<string, CloudCapability> = Object.fromEntries(
  CLOUD_CAPABILITY_KEYS.map((c) => [CLOUD_CAPABILITIES[c].code, c]),
);

/** Reverse a wire error code back to its capability (null for anything else,
 *  including CLOUD_UNREACHABLE which is not a per-capability requirement). */
export function parseCloudRequiredCode(code: string | null | undefined): CloudCapability | null {
  if (!code) return null;
  return CODE_TO_CAPABILITY[code] ?? null;
}

// ─── The ONE needs-cloud predicate ───────────────────────────────────────────
// A managed/free domain (`domainType !== "custom"`) routes through the Openship
// Cloud edge, so it needs a cloud connection; a custom domain works self-hosted.
// This is the single definition every gate (client + server) shares.

export function endpointNeedsCloud(domainType: string | null | undefined): boolean {
  return domainType !== "custom";
}

export function endpointsNeedCloud(
  endpoints?: ReadonlyArray<{ domainType?: string | null }> | null,
): boolean {
  return !!endpoints?.length && endpoints.some((e) => endpointNeedsCloud(e.domainType));
}

export function servicesNeedCloud(
  services?: ReadonlyArray<{ exposed?: boolean; domainType?: string | null }> | null,
): boolean {
  return !!services?.length && services.some((s) => s.exposed && endpointNeedsCloud(s.domainType));
}
