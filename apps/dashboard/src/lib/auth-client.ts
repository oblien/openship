import { createAuthClient } from "better-auth/react";
import { organizationClient, emailOTPClient, twoFactorClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { getAuthBaseUrl } from "@/lib/api/urls";
import { reportClientError } from "./error-reporting";

/**
 * API base URL - auth requests go directly to the selected API origin.
 *
 * Local SaaS uses localhost:4100. Public-host dev and production use
 * api.openship.io so Better Auth can share cookies with app.openship.io.
 */
const AUTH_BASE_URL = getAuthBaseUrl();

const clientOptions = {
  baseURL: AUTH_BASE_URL,
  fetchOptions: {
    onError: (context) => {
      if (!context.response?.headers.get("X-Request-ID"))
        reportClientError(context.error, { component: "auth-client" });
    },
    credentials: "include",
    // Disable retry to prevent infinite loops on 429
    retry: {
      type: "linear",
      attempts: 0,
      delay: 0,
    },
  },
} satisfies Parameters<typeof createAuthClient>[0];

export const authClient = createAuthClient({
  ...clientOptions,
  plugins: [organizationClient(), emailOTPClient(), passkeyClient(), twoFactorClient()],
});

// The provider plugin adds signed page data to POSTs. Limit that continuation
// behavior to OAuth actions so changing organizations cannot resume the grant.
const oauthClient = createAuthClient({
  ...clientOptions,
  // The consent form owns its continuation. An automatic redirect would race
  // the inline completion and consume the same single-use callback twice.
  disableDefaultFetchPlugins: true,
  plugins: [oauthProviderClient()],
});

export async function submitMcpConsent(
  accept: boolean,
  consentCode: string | null,
): Promise<string | null> {
  const result = await oauthClient.oauth2.consent({
    accept,
    ...(consentCode ? { oauth_query: consentCode } : {}),
  });
  if (result.error) {
    throw Object.assign(new Error("consent failed"), { status: result.error.status });
  }
  return result.data?.url ?? null;
}

/** Password creation for a freshly authenticated OAuth-only account. */
export function setAccountPassword(newPassword: string) {
  return authClient.$fetch<{ status: boolean }>("/account-security/set-password", {
    method: "POST",
    body: { newPassword },
  });
}

export const { signIn, signUp, signOut, useSession } = authClient;

/** Typed helpers supplied by Better Auth and the installed email-OTP plugin. */
export const emailOtp = authClient.emailOtp;

// Keep token-based reset links already delivered to users working. New reset
// requests use emailOtp.sendVerificationOtp and emailOtp.resetPassword.
export const resetPassword = authClient.resetPassword;
export const sendVerificationEmail = authClient.sendVerificationEmail;
export const verifyEmail = authClient.verifyEmail;
