import type { SshPayload } from "./types";

/** Valid hostname / IP pattern (no spaces, no special chars except . - :) */
const IP_HOSTNAME_RE = /^[\w.\-:]+$/;

/**
 * Validate a server IP / hostname string.
 * Returns null if valid, or an error message string.
 */
export function validateServerAddress(ip: string): string | null {
  if (!ip) return "Please enter your server IP address";
  if (!IP_HOSTNAME_RE.test(ip)) return "That doesn't look like a valid IP address";
  return null;
}

/**
 * Validate the SSH payload collected from user input.
 * Returns null if valid, or an error message string.
 */
export function validateSshPayload(payload: Partial<SshPayload>): string | null {
  if (!payload.host) return "Please enter your server IP address";

  const addrErr = validateServerAddress(payload.host);
  if (addrErr) return addrErr;

  if (payload.method === "password" && !payload.password) {
    return "Please enter your server password";
  }
  if (payload.method === "key" && !payload.keyPath) {
    return "Please enter the path to your SSH key";
  }
  return null;
}

/**
 * Detect private / LAN IPs that need a tunnel for internet access.
 */
export function isPrivateIp(ip: string): boolean {
  const host = ip.replace(/:\d+$/, "");
  if (/^10\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^127\./.test(host)) return true;
  if (host === "localhost") return true;
  if (/^(fc|fd)/i.test(host)) return true;
  if (host === "::1") return true;
  return false;
}
