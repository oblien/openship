export const DEFAULT_PORT = {
  web: 3000,
  dashboard: 3001,
  api: 4000,
  saasDashboard: 3002,
  saasApi: 4100,
} as const;

const localhost = (port: number) => `http://localhost:${port}`;

// Standalone URL exports — consumed by desktop, CLI, and onboarding
// flows that want "the localhost dashboard URL" without going through
// the runtime-target table. They're the same strings used inside
// DASHBOARD_RUNTIME_TARGETS below; single source for each value.
export const LOCAL_WEB_URL = localhost(DEFAULT_PORT.web);
export const LOCAL_DASHBOARD_URL = localhost(DEFAULT_PORT.dashboard);
export const LOCAL_API_URL = localhost(DEFAULT_PORT.api);

// The production cloud endpoints — env-overridable so a dev instance can point
// "cloud" at a LOCAL SaaS without editing code or flipping the whole target row.
// Unset (production / the default) → the real remote cloud, so self-hosted
// production is unaffected. Set OPENSHIP_CLOUD_API_URL / OPENSHIP_CLOUD_DASHBOARD_URL
// (e.g. http://localhost:4100 / http://localhost:3002) to exercise cloud flows
// against a local `dev:saas` instance. Only consulted for the `cloud-saas` row.
const envUrl = (key: string): string | undefined => {
  const v = typeof process !== "undefined" ? process.env?.[key] : undefined;
  return v && v.trim() ? v.trim() : undefined;
};
export const CLOUD_DASHBOARD_URL =
  envUrl("OPENSHIP_CLOUD_DASHBOARD_URL") ?? "https://app.openship.io";
export const CLOUD_API_URL = envUrl("OPENSHIP_CLOUD_API_URL") ?? "https://api.openship.io";

/**
 * THE runtime-target table. Keyed by id — the id IS the key, no
 * redundant `id` field on the row. To enable a runtime target,
 * uncomment its entry. OPENSHIP_TARGET picks one row.
 *
 *   OPENSHIP_TARGET=local        (default — self-hosted; talks to cloud-saas)
 *   OPENSHIP_TARGET=cloud-saas   (the SaaS — api.openship.io in prod, or a
 *                                tunneled localhost during dev:saas)
 *   OPENSHIP_TARGET=local-saas   (a localhost-only SaaS for dev without
 *                                tunneling api.openship.io)
 *
 * No NODE_ENV magic, no CLOUD_MODE-based inference. Invalid value
 * throws — fail-loud beats silently picking the wrong URL.
 */
export const DASHBOARD_RUNTIME_TARGETS = {
  local: {
    dashboard: LOCAL_DASHBOARD_URL,
    api: LOCAL_API_URL,
    ports: { dashboard: DEFAULT_PORT.dashboard, api: DEFAULT_PORT.api },
    cloudTargetId: "cloud-saas",
    selfHosted: true,
  },
  "local-saas": {
    dashboard: localhost(DEFAULT_PORT.saasDashboard),
    api: localhost(DEFAULT_PORT.saasApi),
    ports: { dashboard: DEFAULT_PORT.saasDashboard, api: DEFAULT_PORT.saasApi },
    // Self-referential — dev:saas IS the SaaS when this row is active,
    // so cloud calls land back on itself at localhost:4100 instead of
    // round-tripping to api.openship.io.
    cloudTargetId: "local-saas",
    selfHosted: false,
  },
  "cloud-saas": {
    dashboard: CLOUD_DASHBOARD_URL,
    api: CLOUD_API_URL,
    ports: { dashboard: DEFAULT_PORT.saasDashboard, api: DEFAULT_PORT.saasApi },
    cloudTargetId: "cloud-saas",
    selfHosted: false,
  },
} as const;

// NOTE: this table is the source of truth for WHO an instance is (identity,
// URLs, ports) + whether it's self-hosted. It deliberately does NOT carry
// deploy/build mode (docker | bare | cloud | desktop) or product edition
// (operator | cloud): those are orthogonal axes owned by the API's env
// (DEPLOY_MODE / CLOUD_MODE). Edition is CLOUD_MODE → cloud, else operator
// (`edition.ts`) and is surfaced on GET /health/env. Keeping a copy here only
// bred drift (e.g. local→"docker" while DEPLOY_MODE=desktop).

export type DashboardRuntimeTargetId = keyof typeof DASHBOARD_RUNTIME_TARGETS;
export type DashboardRuntimeTarget = (typeof DASHBOARD_RUNTIME_TARGETS)[DashboardRuntimeTargetId];

// SINGLE knob, resolved ONCE at module load. process.env.OPENSHIP_TARGET
// picks the row. Invalid value throws fail-loud.
const rawTarget =
  (typeof process !== "undefined" ? process.env?.OPENSHIP_TARGET : undefined) ?? "local";
if (!(rawTarget in DASHBOARD_RUNTIME_TARGETS)) {
  throw new Error(
    `OPENSHIP_TARGET="${rawTarget}" is not a valid runtime target. ` +
      `Use one of: ${Object.keys(DASHBOARD_RUNTIME_TARGETS).join(", ")}.`,
  );
}

export const runtimeTargetId = rawTarget as DashboardRuntimeTargetId;
export const runtimeTarget = DASHBOARD_RUNTIME_TARGETS[runtimeTargetId];

// Optional override for WHERE "cloud" points. A self-hosted instance normally
// talks to cloud-saas (api.openship.io); set OPENSHIP_CLOUD_TARGET=local-saas to
// point it at a localhost SaaS (localhost:4100) for end-to-end local testing.
// Unset/invalid → falls back to the active target's own cloudTargetId, so
// production self-hosted is unaffected (no env = cloud-saas as before).
const rawCloudTarget =
  typeof process !== "undefined" ? process.env?.OPENSHIP_CLOUD_TARGET : undefined;
export const cloudRuntimeTargetId: DashboardRuntimeTargetId =
  rawCloudTarget && rawCloudTarget in DASHBOARD_RUNTIME_TARGETS
    ? (rawCloudTarget as DashboardRuntimeTargetId)
    : runtimeTarget.cloudTargetId;
export const cloudRuntimeTarget = DASHBOARD_RUNTIME_TARGETS[cloudRuntimeTargetId];

// Every dashboard + api origin from the table — used for CORS allowlists.
export const dashboardRuntimeOrigins = Object.values(DASHBOARD_RUNTIME_TARGETS).flatMap(
  ({ dashboard, api }) => [dashboard, api],
);

export const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Align a loopback origin with the loopback host of a reference origin.
 *
 * `localhost` and `127.0.0.1` are the same machine but *different sites* to a
 * browser: a request between them is cross-site, so a host-only SameSite=Lax
 * cookie minted on one host is never sent to the other. Rewriting the hostname
 * (port + protocol of `injected` preserved) keeps the pair same-site. Only
 * touches origins where BOTH are loopback — non-loopback (production) origins
 * pass through untouched, so this can never redirect off-box.
 *
 * Shared by the dashboard (align the injected API origin to the page host) and
 * the API (align the desktop-login redirect target to the request host).
 */
export function alignLoopbackOrigin(injected: string, referenceOrigin: string): string {
  try {
    const target = new URL(injected);
    const reference = new URL(referenceOrigin);
    if (!LOOPBACK_HOSTNAMES.has(target.hostname) || !LOOPBACK_HOSTNAMES.has(reference.hostname)) {
      return injected;
    }
    target.hostname = reference.hostname;
    return `${target.protocol}//${target.host}`;
  } catch {
    // A malformed origin is passed through untouched — callers already tolerate
    // a bad origin, and repairing it here would hide the real config bug.
    return injected;
  }
}
