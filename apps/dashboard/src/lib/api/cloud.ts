import { api } from "./client";
import { endpoints } from "./endpoints";
import type { CloudConnectAuthorizeBody, CloudConnectAuthorizeResponse } from "@repo/contracts";
export type { CloudConnectAuthorizeBody, CloudConnectAuthorizeResponse } from "@repo/contracts";

export interface CloudStatus {
  connected: boolean;
  user?: { id?: string; organizationId?: string; name: string; email: string; image?: string | null };
}

export interface CloudConnectFinalizeBody {
  code: string;
  codeVerifier?: string;
}

export interface CloudConnectFinalizeResponse {
  ok: boolean;
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
