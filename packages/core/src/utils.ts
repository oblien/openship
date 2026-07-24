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
    .slice(0, 100)
    .replace(/^-+|-+$/g, "");
}

/**
 * Canonical stored form of a custom hostname: trimmed, lowercased, scheme
 * stripped, trailing slash removed. The SINGLE normalizer shared by service
 * route storage (@repo/db) and the domain service (@repo/api), so a hostname
 * written in one place always matches a lookup in another — a mismatch here
 * mints duplicate domain rows and registers a bogus vhost.
 */
export function normalizeCustomHostname(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

/**
 * True when `host` (already run through normalizeCustomHostname) is a plausible
 * public DNS hostname. Rejects the shapes a bare hostname must never contain —
 * embedded path / port / scheme leftovers / whitespace, IPv4 literals,
 * localhost, single-label names, and labels longer than the 63-octet DNS limit.
 * The same shape gate the single-app custom domain flow enforces, so service
 * custom domains can't store a bogus host that later becomes an unservable vhost.
 */
export function isValidCustomHostname(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (host === "localhost") return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // IPv4 literal
  if (/[\s/:@\\?#]/.test(host)) return false; // path / port / scheme / userinfo
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false; // must be multi-label (has a dot)
  return labels.every(
    (label) => label.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
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
  if (bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.max(Math.floor(Math.log(bytes) / Math.log(k)), 0), sizes.length - 1);
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

/**
 * Race a promise against a timeout, rejecting with `Error(message)` after `ms`.
 * `ms` of 0/undefined disables the timeout (returns the promise as-is). Clears
 * the timer on settle so it never leaks. One shared impl — callers pass their
 * own message so prior error contracts are preserved.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number | undefined, message: string): Promise<T> {
  if (!ms) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
