/**
 * Trust boundaries for the Electron shell — pure predicates, no `electron`
 * import, so they're unit-testable without a runtime.
 *
 * The invariant they exist to protect: Electron re-attaches the preload
 * `contextBridge` to WHATEVER the main frame navigates to. `window.desktop` is
 * not origin-scoped, so a navigation off our own origin hands the full native
 * bridge to that page. The dashboard renders user-controlled text (repo names,
 * server hostnames, build logs), which makes containing navigation the thing
 * that keeps a renderer bug from becoming native-bridge access.
 */

const HTTP_SCHEMES = new Set(["http:", "https:"]);

const parse = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/**
 * May the main frame load this URL? Our own dashboard/API origins only.
 *
 * Deliberately rejects every non-HTTP scheme rather than allowing the `data:`
 * URL the boot splash uses: a renderer-initiated `data:` navigation would
 * inherit the bridge with an attacker-authored document. The splash still works
 * because it's loaded by `loadURL` from main, and `will-navigate` does not fire
 * for main-initiated navigation.
 *
 * The cloud origin is absent on purpose — cloud auth always goes to the system
 * browser via `shell.openExternal`, never into this frame.
 */
export function isAllowedFrameUrl(url: string, allowedOrigins: string[]): boolean {
  const target = parse(url);
  if (!target || !HTTP_SCHEMES.has(target.protocol)) return false;
  return allowedOrigins.some((origin) => parse(origin)?.origin === target.origin);
}

/**
 * Safe to hand to the OS dispatcher (`shell.openExternal`)?
 *
 * Parses rather than prefix-matching: the old `url.startsWith("http")` check
 * also passed `httpevil://…`. Anything outside http/https can launch a local
 * handler — `file://`, a UNC path (`\\host\share` → outbound SMB/NTLM-hash
 * leak on Windows), or any registered scheme.
 */
export function isSafeExternalUrl(url: string): boolean {
  const parsed = parse(url);
  return !!parsed && HTTP_SCHEMES.has(parsed.protocol);
}

/**
 * What to do with a main-frame navigation the renderer initiated.
 *
 *   "allow"    — one of our own origins.
 *   "external" — off-origin but ordinary web content: cancel the in-frame
 *                navigation and hand it to the system browser. Dashboard links
 *                to docs and github.com/settings/tokens/new have no
 *                target="_blank", so they land here rather than at
 *                setWindowOpenHandler; dropping them would break real links.
 *   "block"    — anything else (data:, file:, javascript:, unparseable).
 */
export type FrameNavigationVerdict = "allow" | "external" | "block";

export function classifyFrameNavigation(
  url: string,
  allowedOrigins: string[],
): FrameNavigationVerdict {
  if (isAllowedFrameUrl(url, allowedOrigins)) return "allow";
  if (isSafeExternalUrl(url)) return "external";
  return "block";
}

/**
 * Config keys the renderer may read and write — update preferences, and nothing
 * else. The same store holds `system` (SSH host/user/password/passphrase) and
 * `tunnel` tokens, which must never cross the bridge.
 */
export const RENDERER_CONFIG_KEYS = [
  "autoUpdate",
  "updateNotifications",
  "dismissedAdvisoryIds",
  "lastSeenVersion",
] as const;

export type RendererConfigKey = (typeof RENDERER_CONFIG_KEYS)[number];

export function isRendererConfigKey(key: unknown): key is RendererConfigKey {
  return (
    typeof key === "string" && (RENDERER_CONFIG_KEYS as readonly string[]).includes(key)
  );
}

/**
 * Hosts an update binary may be downloaded from. The release feed is fetched
 * from the pinned repo, but the asset URL inside it was previously followed
 * wherever it pointed; pinning the host keeps a tampered feed from sourcing the
 * installer elsewhere. `github.com` issues the redirect, the
 * `*.githubusercontent.com` hosts serve the bytes.
 */
const UPDATE_ASSET_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export function isAllowedUpdateAssetUrl(url: string): boolean {
  const parsed = parse(url);
  return !!parsed && parsed.protocol === "https:" && UPDATE_ASSET_HOSTS.has(parsed.hostname);
}
