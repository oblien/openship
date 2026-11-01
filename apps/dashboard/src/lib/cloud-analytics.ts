import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type {
  CloudAttribution,
  CloudBrowserCapture,
  CloudBrowserEvent,
  CloudAnalyticsProperties,
} from "@repo/contracts";
import { getRestApiBaseUrl } from "./api/urls";

const STORAGE_KEY = "openship:cloud-analytics:v1";
type Identity = { anonymousId: string; userId: string | null; attribution: CloudAttribution };
let identity: Identity | null = null;
let active = false;

export function analyticsScreen(
  pathname: string,
): CloudAnalyticsProperties<"cloud_page_viewed">["screen"] {
  const parts = pathname.split("/").filter(Boolean);
  if (!parts.length) return "home";
  if (parts[0] === "projects") {
    if (!parts[1]) return "projects";
    const tabs = {
      topology: "project_topology",
      services: "project_services",
      environment: "project_environment",
      domains: "project_domains",
      deployments: "project_deployments",
      backups: "project_backups",
      settings: "project_settings",
      source: "project_source",
    } as const;
    return tabs[parts[2] as keyof typeof tabs] ?? "project_overview";
  }
  if (parts[0] === "billing")
    return parts[1] === "plans"
      ? "billing_plans"
      : !parts[1] || parts[1] === "overview"
        ? "billing_overview"
        : "billing_other";
  if (parts[0] === "settings")
    return parts[1] === "git" ? "settings_git" : parts[1] === "mcp" ? "settings_mcp" : "settings";
  const screens = {
    login: "login",
    register: "signup",
    signup: "signup",
    "sign-up": "signup",
    "verify-email": "verify",
    onboarding: "onboarding",
    library: "library",
    deploy: "create_project",
    build: "deployment",
    backups: "backups",
    servers: "servers",
    clusters: "clusters",
    monitoring: "monitoring",
  } as const;
  return screens[parts[0] as keyof typeof screens] ?? "other";
}

export function analyticsAttribution(href: string, referrer: string): CloudAttribution {
  const result: CloudAttribution = {};
  try {
    const url = new URL(href);
    for (const key of ["utm_source", "utm_medium", "utm_campaign"] as const) {
      const value = url.searchParams.get(key);
      if (
        value &&
        /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/.test(value) &&
        !/^(?:gh[pousr]_|github_pat_|sk_|phc_|opsh_pat_)/i.test(value)
      )
        result[key] = value;
    }
    if (referrer) {
      const from = new URL(referrer);
      // Referrer host only, never credentials, private IPs, paths or queries.
      if (
        from.protocol === "https:" &&
        !from.username &&
        !from.password &&
        from.hostname !== url.hostname &&
        /^[a-z0-9.-]+\.[a-z]{2,}$/.test(from.hostname) &&
        !from.hostname.endsWith(".local") &&
        from.hostname.length <= 253
      )
        result.referrer_host = from.hostname;
    }
  } catch {
    /* Invalid attribution is omitted. */
  }
  return result;
}

/** Called only with immutable API deployment info, never the UI's Cloud toggle. */
export function configureCloudAnalytics(
  config: { dashboardOrigin: string } | undefined,
  userId: string | null,
  demo: boolean,
): void {
  active = false;
  if (
    typeof window === "undefined" ||
    process.env.NODE_ENV !== "production" ||
    !config ||
    demo ||
    window.location.origin !== config.dashboardOrigin ||
    window.location.protocol !== "https:" ||
    (window as unknown as { desktop?: { isDesktop?: boolean }; __OPENSHIP_API_ORIGIN__?: string })
      .desktop?.isDesktop ||
    (window as unknown as { __OPENSHIP_API_ORIGIN__?: string }).__OPENSHIP_API_ORIGIN__
  )
    return;
  try {
    // Re-read storage at auth boundaries so logout/account changes in another
    // tab cannot re-use a previous customer's anonymous identity.
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const saved = raw ? (JSON.parse(raw) as Identity) : identity;
    if (
      saved &&
      typeof saved.anonymousId === "string" &&
      /^[a-f0-9-]{36}$/.test(saved.anonymousId) &&
      (saved.userId === null || typeof saved.userId === "string")
    )
      identity = saved;
  } catch {
    /* Storage can be unavailable; an in-memory identity is sufficient. */
  }
  const changedAccount = identity?.userId && identity.userId !== userId;
  if (!identity || changedAccount) {
    if (!globalThis.crypto?.randomUUID) return;
    identity = {
      anonymousId: crypto.randomUUID(),
      userId,
      attribution: analyticsAttribution(window.location.href, document.referrer),
    };
  }
  identity.userId = userId;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "dashboard/lib/cloud-analytics");
    /* Optional storage. */
  }
  active = true;
}

export function stopCloudAnalytics(): void {
  active = false;
}

export function trackCloudEvent(data: CloudBrowserEvent): void {
  if (!active || !identity) return;
  try {
    const payload: CloudBrowserCapture = {
      id: crypto.randomUUID(),
      anonymousId: identity.anonymousId,
      expectedUserId: identity.userId,
      attribution: identity.attribution,
      data,
    };
    // First-party, explicit events only. This integration loads no PostHog browser
    // SDK, DOM autocapture, replay, IP lookup, or third-party browser script.
    void fetch(`${getRestApiBaseUrl().replace(/\/+$/, "")}/cloud/telemetry`, {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3_000),
    }).catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "dashboard/lib/cloud-analytics");
    });
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "dashboard/lib/cloud-analytics");
    /* Telemetry must never interrupt checkout/navigation. */
  }
}

export function trackCloudCheckoutReturn(search: string): void {
  const query = new URLSearchParams(search);
  for (const [parameter, kind] of [
    ["checkout", "subscription"],
    ["topup", "topup"],
  ] as const) {
    const result = query.get(parameter);
    if (result === "success" || result === "cancelled")
      trackCloudEvent({ event: "cloud_checkout_returned", properties: { kind, result } });
  }
}
