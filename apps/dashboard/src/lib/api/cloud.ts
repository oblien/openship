import { api } from "./client";
import { endpoints } from "./endpoints";

export interface CloudStatus {
  connected: boolean;
  user?: { name: string; email: string; image?: string | null };
}

export interface CloudConnectFinalizeBody {
  code: string;
  codeVerifier?: string;
}

export interface CloudConnectFinalizeResponse {
  ok: boolean;
}

export interface CloudConnectAuthorizeBody {
  /** Browser-redirect (desktop/local) flow only — the URL the code is delivered
   *  to. Omitted for device/poll (mode="device"), where the CLI retrieves the
   *  code via connect-poll and there's nothing to navigate to. */
  redirect?: string;
  state: string;
  codeChallenge: string;
  /** "device" = headless CLI poll flow: confirm in-place, no redirect. */
  mode?: "device";
}

export interface CloudConnectAuthorizeResponse {
  /** Present only for the browser-redirect flow. */
  callbackUrl?: string;
  /** Present for the device/poll flow — the code is picked up via connect-poll. */
  authorized?: boolean;
}

export const cloudApi = {
  /** Disconnect from Openship Cloud */
  disconnect: () => api.post<CloudStatus>(endpoints.cloud.disconnect),

  /** Check current cloud connection status */
  status: () => api.get<CloudStatus>(endpoints.cloud.status),

  /** Finalize the connect popup flow — POSTs the one-time code and the
   *  PKCE verifier (stashed in localStorage by CloudContext before the
   *  popup opened). Called from /cloud-connect-callback. */
  connectFinalize: (body: CloudConnectFinalizeBody) =>
    api.post<CloudConnectFinalizeResponse>(endpoints.cloud.connectFinalize, body),

  /** Confirm the cloud-connect consent step. Called from the dashboard
   *  /cloud-authorize page after the user clicks "Authorize". Requires
   *  a Better-Auth session cookie on the cloud origin; the server
   *  returns 401 if missing (the page bounces to /login on that). */
  connectAuthorize: (body: CloudConnectAuthorizeBody) =>
    api.post<CloudConnectAuthorizeResponse>(endpoints.cloud.connectAuthorize, body),
};
