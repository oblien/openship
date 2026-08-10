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
 * Redirect codes a canonical host redirect may use, and the one it defaults to.
 *
 * Lives here because BOTH sides of the package boundary need the same list: the
 * API validates an operator's choice against it (lib/domain-redirect.ts) and the
 * edge renderer re-checks before interpolating it into a vhost
 * (adapters/infra/nginx.ts — an out-of-range value there would emit `return 0`
 * and make `openresty -t` reject the whole file). Two copies could drift into a
 * status the API accepts and the edge refuses.
 */
export const REDIRECT_STATUSES = [301, 302, 307, 308] as const;
export type RedirectStatus = (typeof REDIRECT_STATUSES)[number];
export const DEFAULT_REDIRECT_STATUS: RedirectStatus = 301;

/** Coerce to a usable redirect code, falling back to 301. */
export function resolveRedirectStatus(status?: number | null): RedirectStatus {
  return REDIRECT_STATUSES.includes(status as RedirectStatus)
    ? (status as RedirectStatus)
    : DEFAULT_REDIRECT_STATUS;
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
 * Comparison form of a hostname READ BACK from serving config — an nginx
 * `server_name`, a DNS answer, a cert SAN.
 *
 * Trim + lowercase + drop the FQDN root dot, and nothing else. `example.com.` is
 * legal in `server_name` and in DNS, so anything comparing live config against
 * stored rows must fold that away or it silently fails to match its own domain.
 *
 * Deliberately NOT built on {@link normalizeCustomHostname}, even though it looks
 * like a superset: that one also strips `https://` and trailing slashes, which
 * would make `isApexDomain` (below) start accepting scheme-prefixed input it
 * previously rejected. This is byte-for-byte the expression `isApexDomain` already
 * open-coded, so extracting it changes no behavior anywhere — it just stops the
 * edge-orphan sweep from being a third copy.
 *
 * The split from `normalizeCustomHostname` is real, not incidental: that one
 * normalizes USER INPUT (where a trailing dot is rejected by
 * {@link isValidCustomHostname}); this one normalizes MACHINE OUTPUT.
 */
export function normalizeServedHostname(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * The `www.` sibling of a hostname, or null when there isn't one to claim
 * because the hostname already IS a www host.
 *
 * ONE rule, because "Include www" fans out to three places that each need the
 * same answer — the row the add path creates, the SAN the cert covers, and the
 * DNS record the setup panel shows. Three inline `www.${host}` prefixes meant a
 * "no stacking www on www" guard could exist in one and be missing in another,
 * producing a `www.www.example.com` row or a record for a hostname that never
 * gets a row.
 */
export function wwwSiblingHostname(hostname: string): string | null {
  const host = normalizeCustomHostname(hostname);
  if (!host || host.startsWith("www.")) return null;
  return `www.${host}`;
}

/**
 * True when `value` is a plausible email address.
 *
 * The ONE email rule, because the CLI had two and both let bad input through: the
 * interactive wizard only checked for an `@` (so `test@gmail.co,` created an admin
 * account nobody could receive mail at), and the headless resolver used
 * `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, which also accepts a trailing comma since `,` is
 * neither whitespace nor `@`. Used for the admin login and the ACME contact — a
 * malformed address there fails certificate issuance later, far from the typo.
 *
 * Intentionally practical, not RFC 5322: local part of the common characters, a
 * dotted domain, and a TLD of 2+ letters. Quoted local parts and IP-literal
 * domains are rejected — they're valid in the spec and never what someone typed
 * into a setup prompt.
 */
export function isValidEmail(value: string): boolean {
  const email = value?.trim() ?? "";
  if (!email || email.length > 254) return false;
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(email);
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

/**
 * Public suffixes whose registrable domain is THREE labels (`example.co.uk`),
 * not two. Deliberately NOT the full Public Suffix List — that needs a
 * dependency we don't carry — just the handful common enough that mis-classifying
 * `example.co.uk` as a subdomain would be visibly wrong. Extend as usage demands.
 */
const MULTI_PART_TLDS = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "net.uk", "ltd.uk", "plc.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz",
  "co.jp", "or.jp", "ne.jp",
  "co.in", "net.in", "org.in", "firm.in",
  "com.br", "net.br", "org.br",
  "com.mx", "com.sg", "com.tr", "co.za", "com.cn",
]);

/**
 * True when `host` is an APEX / registrable domain (`example.com`,
 * `example.co.uk`) rather than a subdomain (`app.example.com`, `www.example.com`).
 *
 * Used to decide whether offering a `www.` variant makes sense — `www.<subdomain>`
 * almost never does, so the UI hides the www toggle for subdomains. Heuristic, not
 * the full PSL (no dependency): apex = exactly one label in front of the public
 * suffix, where the suffix is two labels for the common multi-part TLDs above and
 * one label otherwise. Input should already be normalized (see normalizeCustomHostname).
 */
export function isApexDomain(host: string): boolean {
  const h = normalizeServedHostname(host);
  if (!isValidCustomHostname(h)) return false;
  const labels = h.split(".");
  const lastTwo = labels.slice(-2).join(".");
  const suffixLabels = MULTI_PART_TLDS.has(lastTwo) ? 2 : 1;
  return labels.length === suffixLabels + 1;
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

/**
 * A POSIX-style environment variable NAME (letter/underscore, then
 * alphanumerics/underscores). Single source for the rule that was duplicated
 * across the connection service, the jobs runner, and the compose parser.
 */
export function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}
