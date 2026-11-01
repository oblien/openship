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

/** OS input is untrusted. Reject other handlers, extra fields, credentials and
 * arbitrary paths before queuing anything in the Desktop process. */
export function parseDesktopInstanceLink(value: string): string | null {
  if (value.length > 4096 || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== `${DESKTOP_INSTANCE_SCHEME}:` ||
      url.hostname !== "connect" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      !["", "/"].includes(url.pathname)
    )
      return null;
    const entries = [...url.searchParams];
    if (entries.length !== 1 || entries[0]?.[0] !== "url") return null;
    const address = entries[0][1];
    if (!/^https?:\/\//.test(address)) return null;
    return connectionAddress(address);
  } catch {
    return null;
  }
}
