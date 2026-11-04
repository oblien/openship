/** Shared wire contract for Cloud approval and the CLI's PKCE handoff. */
export interface CloudConnectAuthorizeBody {
  redirect?: string;
  state: string;
  codeChallenge: string;
  mode?: "desktop" | "device";
  /** Device approval only: the confirmation code printed in the terminal. */
  userCode?: string;
}

export interface CloudConnectAuthorizeResponse {
  callbackUrl?: string;
  authorized?: boolean;
}

export interface CloudDeviceAuthorization {
  state: string;
  user_code: string;
  expires_in: number;
}

export const CLOUD_DEVICE_USER_CODE_LENGTH = 8;

export function isCloudCodeChallenge(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,128}$/.test(value);
}

export function isCloudHandoffState(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function normalizeCloudDeviceUserCode(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export function isCloudDeviceUserCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 32 &&
    normalizeCloudDeviceUserCode(value).length === CLOUD_DEVICE_USER_CODE_LENGTH
  );
}

export function isCloudDeviceAuthorization(value: unknown): value is CloudDeviceAuthorization {
  if (!value || typeof value !== "object") return false;
  return (
    "state" in value &&
    isCloudHandoffState(value.state) &&
    "user_code" in value &&
    isCloudDeviceUserCode(value.user_code) &&
    "expires_in" in value &&
    typeof value.expires_in === "number" &&
    Number.isSafeInteger(value.expires_in) &&
    value.expires_in > 0
  );
}
