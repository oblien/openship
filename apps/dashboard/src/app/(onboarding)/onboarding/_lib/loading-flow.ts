import {
  buildSshSettings,
  buildSetupPayload,
} from "@repo/onboarding";
import { api, getApiBaseUrl } from "@/lib/api";
import { buildDesktopAuthorizeUrl, preparePkceFlow } from "@/lib/cloud-auth";
import type { OnboardingState } from "@repo/onboarding";
import type { Dictionary } from "@/i18n";

export type LoadingStatus = {
  title: string;
  message: string;
};

/** Localized loading-screen copy, threaded in from the consuming component
 *  (`t.onboarding.loading`) so this module stays hook-free. */
export type LoadingLabels = Dictionary["onboarding"]["loading"];

export type LoadingResult =
  | { ok: true }
  | { ok: false; status: LoadingStatus };

async function getCloudLoginUrl(cloudAuthUrl?: string) {
  const apiBase = getApiBaseUrl().replace(/\/$/, "");
  const callbackUrl = `${apiBase}/auth/cloud-callback`;
  // Mint + stash a fresh PKCE verifier so the cloud-callback endpoint
  // can finish a PKCE exchange instead of accepting a bearer code.
  const { state, codeChallenge } = await preparePkceFlow();
  return buildDesktopAuthorizeUrl({ cloudAuthUrl, callbackUrl, state, codeChallenge });
}

async function runCloudFlow(
  cloudAuthUrl: string | undefined,
  setStatus: (status: LoadingStatus) => void,
  isCancelled: () => boolean,
  labels: LoadingLabels,
): Promise<LoadingResult> {
  setStatus({
    title: labels.redirectingCloud,
    message: labels.newTabSignIn,
  });
  const cloudLoginUrl = await getCloudLoginUrl(cloudAuthUrl);
  window.open(cloudLoginUrl, "_blank");
  return { ok: true };
}

async function runSelfHostedFlow(
  state: OnboardingState,
  labels: LoadingLabels,
): Promise<LoadingResult> {
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
        title: labels.couldNotSaveTitle,
        message: labels.couldNotSaveMsg,
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
  labels: LoadingLabels;
}): Promise<LoadingResult> {
  const { state, cloudAuthUrl, setStatus, isCancelled, labels } = options;

  if (state.path === "cloud") {
    return runCloudFlow(cloudAuthUrl, setStatus, isCancelled, labels);
  }

  setStatus({
    title: labels.savingConfig,
    message: labels.almostThere,
  });

  const result = await runSelfHostedFlow(state, labels);
  if (!result.ok || isCancelled()) {
    return result;
  }

  setStatus({
    title: labels.settingUpAccount,
    message: labels.creatingSession,
  });

  return result;
}
