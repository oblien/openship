import { SYSTEM } from "@repo/core";
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

/** Why a `.opsh.io` target is refused. `fix` differs by source: the instance's own
 *  address comes from env, a server row's comes from the row. */
const cloudEdgeTargetReason = (address: string, fix: string) =>
  `"${address}" is a ${SYSTEM.DOMAINS.CLOUD_DOMAIN} hostname, which IS the Openship Cloud edge — ` +
  `proxying there would loop back to the edge instead of reaching the box. ${fix}`;

const CLOUD_EDGE_FIX_INSTANCE = "Set SERVER_IP to this server's own public IP.";
const CLOUD_EDGE_FIX_SERVER = "Correct the server's address in Settings → Servers.";

/**
 * Is this host the Openship Cloud edge itself (`*.opsh.io`)?
 *
 * A Cloud hostname is perfectly public — `isNonPublicHost` rightly says so — but it
 * is never a valid edge TARGET: Oblien terminates `<slug>.opsh.io` and forwards to
 * the target, so a `.opsh.io` target sends the request straight back into the edge
 * that produced it. That is a live self-loop, not a dead route, which is why the
 * loopback guard never caught it.
 *
 * It happens on the normal path, not an exotic one: a free-domain install sets the
 * box's `OPENSHIP_PUBLIC_URL` to `https://<slug>.opsh.io`, and that env var is the
 * first candidate the target resolver reads.
 */
export function isCloudEdgeHost(value: string): boolean {
  // Normalize through the SAME extractor the resolver uses, so a URL
  // (`https://x.opsh.io/y`) and a `host:port` are recognized too — callers pass
  // whichever shape they happen to hold, and a raw suffix check would miss both.
  const h = hostFrom(value)?.toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  const base = SYSTEM.DOMAINS.CLOUD_DOMAIN.toLowerCase();
  return h === base || h.endsWith(`.${base}`);
}

/** Loopback / RFC-1918 / link-local / unspecified — unreachable from the internet. */
export function isNonPublicHost(host: string): boolean {
  // Reduce to a bare host so a URL or host:port is judged on its ADDRESS, matching
  // what `isCloudEdgeHost` accepts. Unnormalized, `https://127.0.0.1` and
  // `localhost:3000` matched none of the patterns below and came back "public" —
  // the exact inverse of the truth, silently.
  //
  // Deliberately NOT `hostFrom`: it drops a port with a plain `split(":")`, which
  // mangles a bare IPv6 literal (`fc00::1` → `fc00`). The ULA regex needs a trailing
  // ":", so it would stop matching and every ULA/link-local address would read as
  // public. Hence the colon-count rule below.
  let h = host
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/\/.*$/, "");
  const bracketed = h.match(/^\[([^\]]*)\]/);
  if (bracketed) {
    h = bracketed[1]!; // [::1] / [::1]:8080 → the literal, port discarded
  } else if ((h.match(/:/g)?.length ?? 0) === 1) {
    h = h.split(":")[0]!; // exactly one colon = host:port; 2+ = bare IPv6, keep it
  }
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

type Candidate = string | null | undefined;

/** First usable edge target in `candidates` (order = precedence), else null. Skips
 *  unreachable hosts AND the Cloud edge's own domain (a `.opsh.io` target
 *  self-loops). Named "usable", not "public": a cloud host is public and still
 *  unusable. */
function firstUsableTarget(candidates: readonly Candidate[]): string | null {
  for (const c of candidates) {
    const h = hostFrom(c);
    if (h && !isNonPublicHost(h) && !isCloudEdgeHost(h)) return h;
  }
  return null;
}

/**
 * Resolve the public host for the edge `target`. THE one decision point — every
 * caller that wires a `<slug>.opsh.io` route comes through here, so the rules for
 * "what may be an edge target" live in exactly one place.
 *
 * - Remote server (row is NOT `isLocal`): its `sshHost` is the reachable address.
 * - `isLocal "This Server"` / no server: this box runs the workload, so use the
 *   INSTANCE's public address — a caller-supplied `preferHost`, OPENSHIP_PUBLIC_URL
 *   host, SERVER_IP, the verified self-app domain, or HOST_DOMAIN — never the
 *   display `sshHost`.
 *
 * `preferHost` is a candidate, NOT an override: setup passes the operator's
 * `--public-url` host here and it gets the same two guards as everything else.
 * Trusting it blindly is what wired `<slug>.opsh.io` at itself.
 */
export async function resolveEdgeTargetHost(
  organizationId: string,
  opts: { serverId?: string; preferHost?: string } = {},
): Promise<EdgeTargetResult> {
  const { serverId, preferHost } = opts;
  if (serverId) {
    const server = await repos.server.getInOrganization(serverId, organizationId).catch(() => null);
    if (server && !server.isLocal) {
      const host = hostFrom(server.sshHost);
      if (!host) return { host: null, reason: "the target server has no host address" };
      if (isNonPublicHost(host)) {
        return { host: null, reason: `the target server address (${host}) is not publicly reachable` };
      }
      if (isCloudEdgeHost(host)) {
        // A server row pointing at the shared edge is fixed on the ROW, not in env.
        return { host: null, reason: cloudEdgeTargetReason(host, CLOUD_EDGE_FIX_SERVER) };
      }
      return { host };
    }
    // isLocal row → fall through to the instance's own public address.
  }

  // The instance's own candidates, in precedence order. Split into two stages only
  // so the reachability lookup stays LAZY — env answering first must not cost a
  // probe. Both stages are named arrays and the failure reason below reads those
  // same arrays, so a source added here is automatically considered there; spelling
  // the list out twice is how the two drift.
  const envCandidates: readonly Candidate[] = [preferHost, env.OPENSHIP_PUBLIC_URL, env.SERVER_IP];
  const fromEnv = firstUsableTarget(envCandidates);
  if (fromEnv) return { host: fromEnv };

  // No env seed — fall back to the verified self-app domain (the box's real
  // public URL once the operator added a domain in the Domains tab).
  const reach = await getInstanceReachability().catch(() => null);
  const reachCandidates: readonly Candidate[] = [reach?.url, env.HOST_DOMAIN];
  const fromReach = firstUsableTarget(reachCandidates);
  if (fromReach) return { host: fromReach };

  // Distinguish "no address at all" from "the only address we have is the Cloud
  // edge". Both leave the free URL unwired, but the fixes are different, and a
  // free-domain install hits the second case with OPENSHIP_PUBLIC_URL set — where
  // "no public address" would read as flatly wrong.
  const looped = [...envCandidates, ...reachCandidates].find((c) => isCloudEdgeHost(c ?? ""));
  return {
    host: null,
    reason: looped
      ? cloudEdgeTargetReason(hostFrom(looped) ?? looped, CLOUD_EDGE_FIX_INSTANCE)
      : NO_PUBLIC_HOST,
  };
}
