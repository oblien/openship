/** Both password and passkey clients can return a pending 2FA challenge. */
export function needsTwoFactor(data: unknown): boolean {
  return (
    !!data &&
    typeof data === "object" &&
    "twoFactorRedirect" in data &&
    data.twoFactorRedirect === true
  );
}

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && "PublicKeyCredential" in window;
}

/** The API returns this only from a signed OAuth continuation cookie. */
export function accountSecurityRedirect(data: unknown): string | null {
  return !!data &&
    typeof data === "object" &&
    "redirectURL" in data &&
    typeof data.redirectURL === "string"
    ? data.redirectURL
    : null;
}
