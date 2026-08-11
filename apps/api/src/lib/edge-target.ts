import { SYSTEM } from "@repo/core";
import { repos } from "@repo/db";
import { env } from "../config/env";
import { getInstanceReachability } from "./public-url";
import { isIpLiteral, resolveInstancePublicIp, resolveLocalServerHost } from "./server-target";

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
 *
 * An IP ALWAYS wins over a hostname (see `resolveEdgeTargetHost`). The edge is
 * addressed by IP so the box's own OpenResty decides what to serve, matching on
 * the `Host:` header the edge forwards; a hostname target hands that decision to
 * whatever the name resolves to instead.
 */
export interface EdgeTargetResult {
  host: string | null;
  /** Set when `host` is null — a user-facing reason the edge can't be wired. */
  reason?: string;
  /** Set when `host` is a HOSTNAME, not an IP — the route is wired, but on
   *  borrowed DNS. Callers surface it; it never blocks the sync. */
  warning?: string;
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

/**
 * THE target string. Openship Cloud keys a target verification on a normalized
 * `scheme://host:port`, and it must be byte-comparable with the string we later
 * route — verifying `http://1.2.3.4` and routing `1.2.3.4:8080` is a permanent
 * `target_unverified` that looks like a Cloud-side bug from here.
 *
 * So this is deliberately shared by BOTH sides: the box calls it to name what it
 * asks to verify, and `syncCloudEdgeProxy` calls it to name what it routes. Two
 * copies of "add http:// if missing" agreeing today is not the same as being
 * unable to disagree.
 *
 * `:80` on http is dropped because it is the default and the two spellings
 * normalize identically upstream; the scheme and host are lowercased because DNS
 * is case-insensitive and a mixed-case declared name would otherwise produce a
 * second, unequal target for the same box.
 */
export function canonicalEdgeTarget(target: string): string {
  const raw = target.trim();
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    const scheme = url.protocol.toLowerCase();
    const port =
      (scheme === "http:" && url.port === "80") || (scheme === "https:" && url.port === "443")
        ? ""
        : url.port;
    // `url.hostname` keeps IPv6 bracketed, which is the form a URL must carry.
    return `${scheme}//${url.hostname.toLowerCase()}${port ? `:${port}` : ""}`;
  } catch {
    // Unparseable input is passed through with only the scheme added. Rejecting it
    // here would turn a target the upstream might well accept into a local failure.
    return withScheme;
  }
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

/** Reachable from the internet AND not the Cloud edge itself (a `.opsh.io`
 *  target self-loops). Named "usable", not "public": a cloud host is public and
 *  still unusable. */
function isUsableTarget(host: string): boolean {
  return !isNonPublicHost(host) && !isCloudEdgeHost(host);
}

/** Usable edge targets from `candidates`, in the order given. */
function usableTargets(candidates: readonly Candidate[]): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    const h = hostFrom(c);
    if (h && isUsableTarget(h)) out.push(h);
  }
  return out;
}

/**
 * A hostname target is FINE, and this note says what it depends on — it is not a
 * failure report. The edge dials the target and forwards `Host: <slug>.opsh.io`,
 * so any address that reaches this box on :80 works: OpenResty matches the vhost
 * on the Host header, which is why hostname targets have been serving correctly.
 *
 * What differs is that the edge re-resolves the NAME on each request, so the route
 * inherits whatever that name points at over time. The two ways that bites, both
 * of which look like "the free URL does nothing": a CDN/proxy put in front of the
 * domain (it has no zone for `<slug>.opsh.io`), or a vhost on it that redirects to
 * its canonical https:// (the visitor lands on that domain, not the app). An IP
 * can't drift that way, hence the pointer — advice, not a defect.
 */
const hostnameTargetWarning = (host: string, fix: string) =>
  `routed by name ("${host}") rather than by IP. That serves fine while the name resolves to this ` +
  `server on port 80, but Openship Cloud's edge re-resolves it per request, so putting a CDN/proxy in ` +
  `front of it — or an https redirect on it — would stop the free URL reaching this app. ${fix}`;

const HOSTNAME_FIX_INSTANCE = "Set SERVER_IP to this server's public IP to pin it.";
const HOSTNAME_FIX_SERVER = "Use the server's IP address in Settings → Servers to pin it.";

/** TTL for the public-IP probe. The probe is 3 sequential HTTP echoes with a 4s
 *  timeout each, and free-domain sync runs per domain in a loop — re-probing for
 *  every hostname in the same edit is pure latency. */
const IP_PROBE_TTL_MS = 5 * 60_000;
let probedIp: { at: number; ip: string | null } | null = null;

/**
 * This box's own public IP: the value stored on the `isLocal` server row at
 * registration first (a pure read), then a live echo probe. The probe exists
 * because the stored value is only as good as what was known at registration —
 * a box registered before detection landed, or with HOST_DOMAIN set (which the
 * row prefers for DISPLAY), has a hostname or `127.0.0.1` there and would
 * otherwise fall through to a hostname target forever.
 */
async function resolveInstanceEdgeIp(organizationId: string): Promise<string | null> {
  const usableIp = (v: string | null) => (v && isIpLiteral(v) && isUsableTarget(v) ? v : null);

  const stored = usableIp(await resolveLocalServerHost(organizationId).catch(() => null));
  if (stored) return stored;

  if (probedIp && Date.now() - probedIp.at < IP_PROBE_TTL_MS) return probedIp.ip;
  // Skips the network on desktop / CLOUD_MODE, where a "public IP" would be a
  // laptop's NAT address — those boxes fall through to the hostname candidates.
  const ip = usableIp(await resolveInstancePublicIp().catch(() => null));
  probedIp = { at: Date.now(), ip };
  return ip;
}

/**
 * Resolve the public host for the edge `target`. THE one decision point — every
 * caller that wires a `<slug>.opsh.io` route comes through here, so the rules for
 * "what may be an edge target" live in exactly one place.
 *
 * - Remote server (row is NOT `isLocal`): its `sshHost` is the reachable address.
 * - `isLocal "This Server"` / no server: this box runs the workload, so use the
 *   INSTANCE's own public address — never the display `sshHost`.
 *
 * For the instance, DECLARED beats GUESSED, and an IP breaks the tie among equals:
 *   1. a declared IP   — `preferHost` / OPENSHIP_PUBLIC_URL / SERVER_IP
 *   2. a declared name  — the same three, then the verified self-app domain /
 *                         HOST_DOMAIN. Serves fine; carries a `warning` saying the
 *                         edge resolves it per request.
 *   3. the box's registered/probed IP — only when nothing was declared, because
 *      the probe reports the EGRESS address, which on a NAT'd/load-balanced host
 *      isn't the inbound one. Ranking a guess over a working stated address would
 *      break routes that serve today.
 *
 * `preferHost` is a candidate, NOT an override: setup passes the operator's
 * `--public-url` host here and it gets the same guards as everything else.
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
      // The row's address is the only one we have for a remote box (we can't probe
      // ITS public IP from here), so a name is used as-is — but still flagged.
      return isIpLiteral(host)
        ? { host }
        : { host, warning: hostnameTargetWarning(host, HOSTNAME_FIX_SERVER) };
    }
    // isLocal row → fall through to the instance's own public address.
  }

  // The instance's own candidates, in precedence order WITHIN their kind. Split
  // into two stages only so the reachability lookup stays LAZY — env answering
  // first must not cost a self-app read. Both stages are named arrays and the
  // failure reason below reads those same arrays, so a source added here is
  // automatically considered there; spelling the list out twice is how they drift.
  const envCandidates: readonly Candidate[] = [preferHost, env.OPENSHIP_PUBLIC_URL, env.SERVER_IP];
  const envUsable = usableTargets(envCandidates);

  // 1. A DECLARED IP wins outright — the operator stated this box's address.
  const envIp = envUsable.find(isIpLiteral);
  if (envIp) return { host: envIp };

  // 2. A DECLARED NAME beats a probed IP, and this ordering is deliberate.
  //
  // A name works whenever it resolves to this box on :80, which is the normal case
  // and is why port-based free domains have been serving fine on hostname targets.
  // The probe below, by contrast, reports the box's EGRESS address — on a NAT'd,
  // load-balanced or floating-IP host that is not the address the internet reaches
  // it on. Preferring the probe would swap a working, operator-stated route for a
  // guess, so it only runs when nothing was declared at all (where the alternative
  // is no route). It also keeps this path free of a network call.
  const reach = await getInstanceReachability().catch(() => null);
  const reachCandidates: readonly Candidate[] = [reach?.url, env.HOST_DOMAIN];
  const name = envUsable[0] ?? usableTargets(reachCandidates)[0];
  if (name) return { host: name, warning: hostnameTargetWarning(name, HOSTNAME_FIX_INSTANCE) };

  // 3. Nothing declared — the box's registered/probed IP, which beats no route.
  const ownIp = await resolveInstanceEdgeIp(organizationId);
  if (ownIp) return { host: ownIp };

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
