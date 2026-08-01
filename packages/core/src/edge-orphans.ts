/**
 * @module edge-orphans
 *
 * Which vhosts is the edge serving that Openship no longer tracks?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Edge config lives on the HOST, deliberately (see the edge bind-mount design),
 * and one supported flow drops the DB rows while leaving it in place:
 * record-only delete ("Remove from Openship only") promises "nothing on the
 * server is touched", which explicitly includes NOT removing the route. So a
 * project can stop existing while its vhost keeps answering.
 *
 * For a port-based vhost that is loud and self-announcing: the container is gone,
 * so it serves 502 and somebody notices. For a STATIC vhost it is silent — the
 * built files are still on disk under the release dir, so it keeps returning
 * 200 with the old project's content, on a hostname Openship may well have since
 * handed to someone else. Nothing in the product looked for this.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 * Report only. It never decides to delete anything: record-only delete's
 * guarantee is that the workload keeps running, and a sweep that quietly removed
 * the vhost would break exactly the promise that created the orphan. Removal is a
 * per-hostname operator action, one at a time, with the target named.
 *
 * Pure: no DB, no executor, no I/O. The caller assembles `sites` (from the edge
 * read api) and `knownHostnames` (from the DB + the non-project route producers)
 * and this answers the set question. Same split as source-access.ts / clone-plan.ts.
 */

import { isValidCustomHostname, normalizeServedHostname } from "./utils";

/** One vhost as the edge reports it, narrowed to what the diff needs. */
export interface EdgeSiteInput {
  /** Every `server_name` the vhost answers to. */
  serverNames: string[];
  ssl: boolean;
  target: { kind: "proxy"; url: string } | { kind: "static"; root: string };
  /** Config file it came from, kept for traceability in the report. */
  source?: string;
}

export interface UntrackedEdgeSite {
  /** The hostname to show the operator — the first real one on the vhost. */
  hostname: string;
  /** Every hostname this vhost answers to (all untracked, or it wouldn't be here). */
  hostnames: string[];
  /**
   * `static` is the dangerous kind: it serves the old project's files with a 200
   * long after the project is gone. `proxy` degrades to 502 once the container
   * goes, which is self-announcing. Callers rank on this.
   */
  kind: "proxy" | "static";
  /** Static docroot, or proxy upstream — how the operator identifies what it is. */
  target: string;
  ssl: boolean;
  source?: string;
}

/**
 * Is this `server_name` token a hostname somebody could actually have claimed?
 *
 * Deliberately delegates to `isValidCustomHostname` — the SAME predicate the
 * domain-claim path uses — rather than hand-rolling exclusions. That keeps one
 * definition of "a hostname an operator can own", so this sweep can't start
 * reporting something the claim path would refuse (or vice versa).
 *
 * It already covers every case that matters here, which is why there is no list:
 *   `_`            nginx catch-all      → single-label, rejected
 *   `localhost`    loopback             → explicitly rejected
 *   `*.opsh.io`    managed wildcard     → `*` fails the label charset
 *   `203.0.113.10` default vhost        → IPv4 literal rejected
 *   `[::1]`, `h:80` IPv6 / host:port    → `:` rejected
 *   `internal`     no dot               → single-label, rejected
 * plus label length and total length bounds this never had.
 */
function isReportableHostname(raw: string): boolean {
  return isValidCustomHostname(normalizeServedHostname(raw));
}

/**
 * Vhosts serving hostnames Openship has no record of.
 *
 * A vhost is tracked when ANY of its `server_name`s is known — one file serves
 * them all, so a single match means the file is accounted for. That direction
 * matters: treating it as untracked because *some* alias is unknown would flag
 * every apex+www vhost the moment one side was removed from the DB.
 *
 * Fails QUIET, not loud: an unparseable or non-hostname `server_name` is skipped
 * rather than reported. This feeds an operator-facing list where a false positive
 * costs trust, and the cost of a miss is bounded (the vhost is still visible in
 * the domains UI once someone claims that hostname).
 */
export function findUntrackedEdgeSites(input: {
  sites: readonly EdgeSiteInput[];
  knownHostnames: readonly string[];
}): UntrackedEdgeSite[] {
  const known = new Set<string>();
  for (const h of input.knownHostnames) {
    const n = normalizeServedHostname(h);
    if (n) known.add(n);
  }

  const out: UntrackedEdgeSite[] = [];
  const seen = new Set<string>();

  for (const site of input.sites) {
    const names = (site.serverNames ?? []).filter(isReportableHostname).map(normalizeServedHostname);
    if (names.length === 0) continue;
    // Any known name ⇒ the vhost is accounted for.
    if (names.some((n) => known.has(n))) continue;

    const hostname = names[0]!;
    if (seen.has(hostname)) continue; // same vhost reported twice by the scanner
    seen.add(hostname);

    out.push({
      hostname,
      hostnames: [...new Set(names)],
      kind: site.target.kind,
      target: site.target.kind === "static" ? site.target.root : site.target.url,
      ssl: !!site.ssl,
      ...(site.source ? { source: site.source } : {}),
    });
  }

  // Static first — it's the kind that serves real content instead of failing —
  // then alphabetical so the list is stable between scans.
  return out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "static" ? -1 : 1;
    return a.hostname.localeCompare(b.hostname);
  });
}
