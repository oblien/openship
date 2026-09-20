const AUTH_ERROR_MESSAGES: Record<string, string> = {
  invalid_client: "The connecting application is not registered or is no longer valid.",
  client_disabled: "The connecting application has been disabled.",
  invalid_request: "The authorization request is incomplete or invalid.",
  invalid_scope: "The connecting application requested unsupported access.",
  unsupported_response_type: "The connecting application used an unsupported authorization flow.",
  access_denied: "Authorization was denied.",
  login_required: "Sign in is required to continue authorization.",
  state_mismatch: "The authorization session could not be verified. Start the connection again.",
  please_restart_the_process: "The authorization session expired. Start the connection again.",
};

export interface AuthErrorDetails {
  code: string;
  message: string;
}

/** Turn OAuth query parameters into bounded, operator-readable copy. */
export function authErrorDetails(
  error: string | null | undefined,
  description: string | null | undefined,
): AuthErrorDetails {
  const code = error?.trim().slice(0, 80) || "authorization_error";
  const safeDescription = description?.trim().slice(0, 300);
  const knownMessage = Object.hasOwn(AUTH_ERROR_MESSAGES, code)
    ? AUTH_ERROR_MESSAGES[code]
    : undefined;
  return {
    code,
    message:
      safeDescription ||
      knownMessage ||
      "The authorization request could not be completed. Start the connection again.",
  };
}
