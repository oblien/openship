/**
 * Shared utility functions.
 *
 * MUST stay isomorphic — this module is in @repo/core's barrel, which client
 * components import, so it can't reference `node:*`. IDs use the Web Crypto
 * API (`crypto.getRandomValues`, global in Node 20+, bun, browsers, and edge)
 * rather than `node:crypto`, so bundling it into the browser doesn't break.
 */

/** URL-safe base64 of raw bytes, no `node:crypto`/Buffer dependency. */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(binary, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a URL-safe slug from a string */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

/** Generate a prefixed unique ID (e.g. "proj_abc123...") */
export function generateId(prefix?: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const id = bytesToBase64Url(bytes);
  return prefix ? `${prefix}_${id}` : id;
}

/** Format bytes to human-readable string */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

/** Format duration in seconds to human-readable string */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Sleep for a given number of milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Align a loopback origin with another loopback host (port preserved).
 *
 * `localhost` and `127.0.0.1` are the same machine but *different sites* to a
 * browser: a request/redirect between them is cross-site, so a host-only
 * SameSite=Lax cookie set on one is never sent back on the other. Non-loopback
 * origins are left untouched.
 */
export function alignLoopbackOrigin(origin: string, otherHost: string): string {
  try {
    const target = new URL(origin);
    if (!LOOPBACK_HOSTNAMES.has(target.hostname) || !LOOPBACK_HOSTNAMES.has(otherHost)) {
      return origin;
    }
    target.hostname = otherHost;
    return `${target.protocol}//${target.host}`;
  } catch {
    return origin;
  }
}
