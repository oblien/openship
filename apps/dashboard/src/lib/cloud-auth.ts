import { getCloudApiOrigin, getCloudDashboardUrl } from "@/lib/api/urls";

export const DESKTOP_CLOUD_FLOW = "desktop-cloud";
const DEFAULT_APP_NAME = "Openship Desktop";
const DEFAULT_POLL_INTERVAL_MS = 2000;

type SearchParamsLike = {
  get(name: string): string | null;
};

type DesktopCloudAuthFailure = "start_failed" | "expired" | "error" | "cancelled";

export function buildDesktopAuthorizeUrl(options: {
  cloudAuthUrl?: string;
  callbackUrl: string;
  appName?: string;
  machine?: string | null;
  state?: string | null;
  codeChallenge?: string | null;
}) {
  const baseUrl = getCloudDashboardUrl(options.cloudAuthUrl);
  const params = new URLSearchParams({
    callback: options.callbackUrl,
    app: options.appName || DEFAULT_APP_NAME,
    flow: DESKTOP_CLOUD_FLOW,
  });

  if (options.machine) params.set("machine", options.machine);
  if (options.state) params.set("state", options.state);
  if (options.codeChallenge) params.set("code_challenge", options.codeChallenge);

  return `${baseUrl}/authorize?${params.toString()}`;
}

export function getCloudConnectHandoffUrl(callbackUrl: string) {
  return `${getCloudApiOrigin()}/api/cloud/connect-handoff?redirect=${encodeURIComponent(callbackUrl)}`;
}

export function getCloudDesktopHandoffUrl(options: {
  callbackUrl: string;
  state?: string | null;
  codeChallenge?: string | null;
}) {
  const params = new URLSearchParams({
    redirect: options.callbackUrl,
    ...(options.state ? { state: options.state } : {}),
    ...(options.codeChallenge ? { code_challenge: options.codeChallenge } : {}),
  });

  return `${getCloudApiOrigin()}/api/cloud/desktop-handoff?${params.toString()}`;
}

export function buildAuthPageHref(route: "/login" | "/register" | "/authorize", searchParams: SearchParamsLike) {
  const params = new URLSearchParams();

  for (const key of ["callback", "app", "machine", "state", "code_challenge", "flow"]) {
    const value = searchParams.get(key);
    if (value) params.set(key, value);
  }

  const query = params.toString();
  return query ? `${route}?${query}` : route;
}

export function getPostAuthRedirect(searchParams: SearchParamsLike) {
  const callback = searchParams.get("callback");
  if (!callback) return null;

  if (searchParams.get("flow") === DESKTOP_CLOUD_FLOW) {
    return buildAuthPageHref("/authorize", searchParams);
  }

  return getCloudConnectHandoffUrl(callback);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startDesktopCloudAuth(options: {
  desktop: DesktopBridge;
  isCancelled?: () => boolean;
  pollIntervalMs?: number;
}) {
  const result = await options.desktop.onboarding.cloudAuth();
  if (!result?.ok || !result.nonce) {
    return { ok: false as const, reason: "start_failed" as DesktopCloudAuthFailure };
  }

  const isCancelled = options.isCancelled ?? (() => false);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  while (!isCancelled()) {
    await sleep(pollIntervalMs);
    const poll = await options.desktop.onboarding.cloudAuthPoll(result.nonce);

    if (poll.status === "resolved") {
      return { ok: true as const };
    }

    if (poll.status === "expired" || poll.status === "error") {
      return { ok: false as const, reason: poll.status };
    }
  }

  return { ok: false as const, reason: "cancelled" as DesktopCloudAuthFailure };
}
