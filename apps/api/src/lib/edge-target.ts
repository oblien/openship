import { repos } from "@repo/db";
import { env } from "../config/env";
import { getInstanceReachability } from "./public-url";

/**
 * The host Openship Cloud's shared edge (Oblien) dials for a free `<slug>.opsh.io`
 * route — it must be a PUBLIC address reachable from the internet on :80, never a
 * loopback/private one.
 *
 * This exists because the deploy server's `sshHost` is the WRONG source for an
 * `isLocal "This Server"` row: that field is display-only (self-server.ts sets it
 * to `SERVER_IP || HOST_DOMAIN || "127.0.0.1"`), so a box with no public URL set
 * would make Oblien proxy `<slug>.opsh.io` at `http://127.0.0.1` — its OWN
 * loopback — which 404s. For a real REMOTE server, `sshHost` IS the reachable
 * address, so we keep using it there.
 *
 * Returns `{ host: null, reason }` (never throws) when no public host resolves, so
 * callers can WARN + continue (the app still deploys; the free URL is marked
 * Action Required) instead of silently wiring a dead route.
 */
export interface EdgeTargetResult {
  host: string | null;
  /** Set when `host` is null — a user-facing reason the edge can't be wired. */
  reason?: string;
}

const NO_PUBLIC_HOST =
  "this server has no public address Openship Cloud can reach — set OPENSHIP_PUBLIC_URL or SERVER_IP";

/** Loopback / RFC-1918 / link-local / unspecified — unreachable from the internet. */
export function isNonPublicHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!h) return true;
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0" || h === "::") return true;
  if (h.startsWith("127.")) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // IPv6 ULA fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // IPv6 link-local fe80::/10
  return false;
}

/** Extract a bare hostname from a URL (`https://x.com/y` → `x.com`) or a bare
 *  host/`host:port` value. Returns null for empty/unparseable input. */
function hostFrom(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (raw.includes("://")) {
    try {
      return new URL(raw).hostname || null;
    } catch {
      return null;
    }
  }
  const stripped = raw.replace(/^\/+/, "").split("/")[0] ?? "";
  // Keep IPv6 literals ([::1]) intact; only strip a :port from host:port forms.
  if (stripped.startsWith("[")) return stripped;
  return stripped.split(":")[0] || null;
}

/** First public host among candidates, else null. */
function firstPublic(...candidates: (string | null | undefined)[]): string | null {
  for (const c of candidates) {
    const h = hostFrom(c);
    if (h && !isNonPublicHost(h)) return h;
  }
  return null;
}

/**
 * Resolve the public host for the edge `target`.
 *
 * - Remote server (row is NOT `isLocal`): its `sshHost` is the reachable address.
 * - `isLocal "This Server"` / no server: this box runs the workload, so use the
 *   INSTANCE's public address — OPENSHIP_PUBLIC_URL host, SERVER_IP, the verified
 *   self-app domain, or HOST_DOMAIN — never the display `sshHost`.
 */
export async function resolveEdgeTargetHost(
  organizationId: string,
  serverId?: string,
): Promise<EdgeTargetResult> {
  if (serverId) {
    const server = await repos.server.getInOrganization(serverId, organizationId).catch(() => null);
    if (server && !server.isLocal) {
      const host = hostFrom(server.sshHost);
      if (!host) return { host: null, reason: "the target server has no host address" };
      if (isNonPublicHost(host)) {
        return { host: null, reason: `the target server address (${host}) is not publicly reachable` };
      }
      return { host };
    }
    // isLocal row → fall through to the instance's own public address.
  }

  const envHost = firstPublic(env.OPENSHIP_PUBLIC_URL, env.SERVER_IP);
  if (envHost) return { host: envHost };

  // No env seed — fall back to the verified self-app domain (the box's real
  // public URL once the operator added a domain in the Domains tab).
  const reach = await getInstanceReachability().catch(() => null);
  const reachHost = firstPublic(reach?.url, env.HOST_DOMAIN);
  if (reachHost) return { host: reachHost };

  return { host: null, reason: NO_PUBLIC_HOST };
}
