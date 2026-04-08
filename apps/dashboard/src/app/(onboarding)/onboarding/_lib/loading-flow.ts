import {
  buildSshSettings,
  buildSetupPayload,
} from "@repo/onboarding";
import { api, getApiBaseUrl } from "@/lib/api";
import { buildDesktopAuthorizeUrl, startDesktopCloudAuth } from "@/lib/cloud-auth";
import type { OnboardingState } from "@repo/onboarding";

export type LoadingStatus = {
  title: string;
  message: string;
};

export type LoadingResult =
  | { ok: true }
  | { ok: false; status: LoadingStatus };

function getCloudLoginUrl(cloudAuthUrl?: string) {
  const apiBase = getApiBaseUrl().replace(/\/$/, "");
  const callbackUrl = `${apiBase}/auth/cloud-callback`;
  return buildDesktopAuthorizeUrl({ cloudAuthUrl, callbackUrl });
}

async function runDesktopCloudAuth(
  desktop: DesktopBridge,
  setStatus: (status: LoadingStatus) => void,
  isCancelled: () => boolean,
): Promise<LoadingResult> {
  setStatus({
    title: "Opening Openship Cloud\u2026",
    message: "Waiting for authentication to complete",
  });

  const result = await startDesktopCloudAuth({ desktop, isCancelled });
  if (!result.ok) {
    return {
      ok: false,
      status: {
        title: result.reason === "start_failed" ? "Could not start cloud authentication" : "Cloud authentication failed",
        message: result.reason === "start_failed"
          ? "The desktop auth flow could not be started."
          : "Please try again and finish sign-in in your browser.",
      },
    };
  }

  setStatus({
    title: "Completing sign-in\u2026",
    message: "Returning to Openship",
  });
  return { ok: true };
}

async function runCloudFlow(
  cloudAuthUrl: string,
  setStatus: (status: LoadingStatus) => void,
  isCancelled: () => boolean,
): Promise<LoadingResult> {
  const desktop = window.desktop;
  if (desktop?.onboarding) {
    return runDesktopCloudAuth(desktop, setStatus, isCancelled);
  }

  setStatus({
    title: "Redirecting to Openship Cloud\u2026",
    message: "You\u2019ll complete sign-in in a new tab",
  });
  window.open(getCloudLoginUrl(cloudAuthUrl), "_blank");
  return { ok: true };
}

async function runSelfHostedFlow(state: OnboardingState): Promise<LoadingResult> {
  const system = state.ssh ? buildSshSettings(state.ssh) : undefined;
  const payload = buildSetupPayload({
    system,
    tunnel: state.tunnel,
    buildMode: state.buildMode,
    authMode: "none",
  });

  try {
    await api.post("system/onboarding", payload);
  } catch {
    return {
      ok: false,
      status: {
        title: "Could not save configuration",
        message: "The API didn\u2019t respond. Make sure services are running.",
      },
    };
  }

  const base = getApiBaseUrl().replace(/\/$/, "");
  window.location.href = `${base}/auth/desktop-login`;
  return { ok: true };
}

export async function runLoadingFlow(options: {
  state: OnboardingState;
  cloudAuthUrl?: string;
  setStatus: (status: LoadingStatus) => void;
  isCancelled: () => boolean;
}): Promise<LoadingResult> {
  const { state, cloudAuthUrl, setStatus, isCancelled } = options;

  if (state.path === "cloud") {
    return runCloudFlow(cloudAuthUrl || "", setStatus, isCancelled);
  }

  setStatus({
    title: "Saving configuration\u2026",
    message: "Almost there",
  });

  const result = await runSelfHostedFlow(state);
  if (!result.ok || isCancelled()) {
    return result;
  }

  setStatus({
    title: "Setting up your account\u2026",
    message: "Creating your session",
  });

  return result;
}