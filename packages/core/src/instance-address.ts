import { instanceOrigin } from "./instance-handoff";

export const DESKTOP_INSTANCE_SCHEME = "openship";

export interface DesktopInstanceLinkRequest {
  id: number;
  address: string;
}

/** Manual connection and OS links share the same destination allowlist. The
 * only return pages are sign-in and the recipient-bound invitation screen. */
export function parseInstanceAddress(value: string): { origin: string; nextPath: string } | null {
  const input = value.trim();
  if (!input || input.length > 2048 || input.startsWith("/") || /[\s\\]/.test(input)) return null;
  const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  const url = new URL(normalized);
  if (url.username || url.password || url.hash || url.search)
    throw new Error(
      "Use an instance or invitation address without credentials or extra parameters.",
    );
  const invitation = /^\/(?:api\/proxy\/)?accept-invite\/([A-Za-z0-9_-]{1,200})$/.exec(
    url.pathname,
  );
  if (invitation)
    return {
      origin: instanceOrigin(
        url.origin + (url.pathname.startsWith("/api/proxy/") ? "/api/proxy" : ""),
      ),
      nextPath: `/accept-invite/${invitation[1]!}`,
    };
  return { origin: instanceOrigin(normalized), nextPath: "/login" };
}

function connectionAddress(value: string): string {
  const parsed = parseInstanceAddress(value);
  if (!parsed) throw new Error("Use a valid instance or invitation address.");
  return parsed.origin + (parsed.nextPath === "/login" ? "" : parsed.nextPath);
}

/** No session, password, pairing token or role travels in a Desktop link.
 * Opening it requests a confirmation in the trusted local UI only. */
export function desktopInstanceLink(address: string): string {
  const url = new URL(`${DESKTOP_INSTANCE_SCHEME}://connect`);
  url.searchParams.set("url", connectionAddress(address));
  return url.href;
}

/** Validate OS input before dispatching either registered Desktop link. */
function desktopLinkParams(
  value: string,
  action: string,
  maxLength: number,
): URLSearchParams | null {
  if (value.length > maxLength || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== `${DESKTOP_INSTANCE_SCHEME}:` ||
      url.hostname !== action ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      !["", "/"].includes(url.pathname)
    )
      return null;
    return url.searchParams;
  } catch {
    return null;
  }
}

export function parseDesktopInstanceLink(value: string): string | null {
  const params = desktopLinkParams(value, "connect", 4096);
  const address = params?.get("url");
  if (params?.size !== 1 || !address || !/^https?:\/\//.test(address)) return null;
  try {
    return connectionAddress(address);
  } catch {
    // diagnostics-ignore: an invalid OS invitation is discarded before it can reach the renderer.
    return null;
  }
}

/** A one-time provider code travels back to the initiating desktop session.
 * The provider's access and refresh tokens stay on the API. */
export interface DesktopConnectionCallback {
  state: string;
  code: string | null;
}

/** The prefix selects the callback transport. The complete state is always
 * generated and bound to the initiating session by the API. */
export const DESKTOP_CONNECTION_STATE_PREFIX = "desktop.";

const connectionCallbackAction = "connection-callback";

function isDesktopConnectionState(state: string | null): state is string {
  return (
    !!state &&
    state.startsWith(DESKTOP_CONNECTION_STATE_PREFIX) &&
    /^[A-Za-z0-9_-]{43}$/.test(state.slice(DESKTOP_CONNECTION_STATE_PREFIX.length))
  );
}

export function desktopConnectionCallbackLink(params: URLSearchParams): string | null {
  const state = params.get("state");
  if (!isDesktopConnectionState(state)) return null;
  const url = new URL(`${DESKTOP_INSTANCE_SCHEME}://${connectionCallbackAction}`);
  url.searchParams.set("state", state);
  const code = params.get("code");
  if (code && code.length <= 4096 && !params.has("error")) url.searchParams.set("code", code);
  return url.href;
}

export function parseDesktopConnectionCallback(value: string): DesktopConnectionCallback | null {
  // A 4096-character code can expand when URL-encoded.
  const params = desktopLinkParams(value, connectionCallbackAction, 50_000);
  if (!params) return null;
  const state = params.get("state");
  const code = params.get("code");
  if (!isDesktopConnectionState(state) || params.size !== (code === null ? 1 : 2)) return null;
  if (code !== null && (!code || code.length > 4096)) return null;
  return { state, code };
}
