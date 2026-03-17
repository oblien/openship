const SSH_AUTH_ERROR_PATTERNS = [
  "All configured authentication methods failed",
];

const RETRYABLE_CONNECTION_ERROR_PATTERNS = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "Timed out",
  "Not connected",
  "Connection lost",
  "read ECONNRESET",
  "Handshake failed",
  "keepalive timeout",
  "SSH connection closed before ready",
];

export function isSshAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return SSH_AUTH_ERROR_PATTERNS.some((pattern) => err.message.includes(pattern));
}

export function isRetryableRemoteConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return RETRYABLE_CONNECTION_ERROR_PATTERNS.some((pattern) =>
    err.message.includes(pattern),
  );
}

export function isRemoteConnectionError(err: unknown): boolean {
  return isSshAuthError(err) || isRetryableRemoteConnectionError(err);
}