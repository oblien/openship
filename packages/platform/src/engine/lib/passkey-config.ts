/** Bind WebAuthn to the declared dashboard origin, independently of the API. */
export function resolvePasskeyConfig(dashboardUrl: string) {
  const url = new URL(dashboardUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Passkeys require an HTTP(S) dashboard URL.");
  }
  return {
    rpID: url.hostname,
    rpName: "Openship",
    origin: url.origin,
    // The anonymous sign-in picker cannot discover a non-resident credential.
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" } as const,
  };
}
