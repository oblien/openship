/**
 * Static-output audit — the file-side counterpart to port-audit.
 *
 * Confirms a static/path-based deployment actually SERVES at each routed path.
 * The audit itself can NEVER throw; the worst it does is record `checked:false`
 * (and no `served`) so callers stay silent. Whether a finding warns or vetoes is
 * the caller's decision, not this module's.
 *
 * VANTAGE POINT is the whole design here, and it's decided once, below. A static
 * site is served by the EDGE reading a `root` path, so the only probe that
 * predicts a 404 is one taken where the edge looks. For a containerized edge the
 * vhost `root` is a HOST path that must be bind-mounted in — probe the host and
 * the files read as present while nginx sees an empty directory and 404s. So the
 * routing provider is asked first (it owns that knowledge), and the runtime's
 * in-container executor is only the fallback for providers that don't serve files.
 *
 * On top of that, when a target names a hostname the probe also makes ONE REAL
 * REQUEST through the edge. A filesystem reading proves the bytes are reachable;
 * only a request proves they are served — it is the sole check that sees an
 * unreadable file mode, a `root` the container cannot traverse, or a vhost that
 * was never written at all.
 */

import {
  probeStaticOutput,
  resolveServedStaticPath,
  type BuildLogger,
  type OutputProbeResult,
  type Platform,
  type RuntimeAdapter,
  type StaticProbeOptions,
} from "@repo/adapters";
import type { OutputCheckResult } from "../../lib/deployment-runtime";
import { normalizeTargetPath } from "../../lib/public-endpoints";

export interface StaticOutputTarget {
  /** The routed targetPath ("/" or "/foo"). */
  path: string;
  /** Where that path serves from — `resolveServedStaticPath(staticRoot, path)`. */
  servedPath: string;
  /**
   * Host to make the HTTP request AS. Absent → the HTTP half is skipped and only
   * the filesystem verdict is produced. A PRIMARY endpoint wins, so the probe asks
   * the canonical hostname rather than whichever alias happened to come first.
   */
  hostname?: string;
}

/**
 * Routed paths → the location each one actually serves from, for the deploy
 * pipeline and the on-demand check alike: the two must probe identical paths, or a
 * drift from the vhost `root` becomes a phantom warning (or a missed 404).
 *
 * The per-path rule itself is `resolveServedStaticPath` — the same call the vhost
 * is built from, so this can't disagree with what the edge was given. It used to
 * be a local copy of that join, described in prose right here; the prose is how
 * you get three copies.
 *
 * With no routed endpoints there is still exactly one thing to check: the root.
 */
export function staticOutputTargets(
  staticRoot: string,
  endpoints: ReadonlyArray<{ targetPath?: string | null; hostname?: string; isPrimary?: boolean }>,
): StaticOutputTarget[] {
  const byPath = new Map<string, StaticOutputTarget>();
  // Whether the hostname stored for a path came from a PRIMARY endpoint. Tracked
  // separately so a later alias can never displace the canonical host, and so a
  // primary arriving after an alias can.
  const primaryPaths = new Set<string>();
  for (const endpoint of endpoints) {
    const path = normalizeTargetPath(endpoint.targetPath) ?? "/";
    // Cardinality is deliberately unchanged: ONE target per unique routed path.
    // `meta.outputCheck`'s length and the dashboard's `c.path === targetPath`
    // matcher both assume it. The only reason to revisit a path already seen is to
    // upgrade its hostname to the canonical one.
    if (byPath.has(path) && (primaryPaths.has(path) || !endpoint.isPrimary)) continue;
    if (endpoint.isPrimary) primaryPaths.add(path);
    byPath.set(path, {
      path,
      servedPath: resolveServedStaticPath(staticRoot, path),
      ...(endpoint.hostname ? { hostname: endpoint.hostname } : {}),
    });
  }
  if (byPath.size === 0) byPath.set("/", { path: "/", servedPath: staticRoot });
  return [...byPath.values()];
}

export interface OutputAuditSource {
  /** Serves the files — asked first; sees what the proxy sees. */
  routing?: Platform["routing"] | null;
  /** Fallback vantage point: inside the deployment itself. */
  runtime?: RuntimeAdapter | null;
  /** Required to acquire the runtime's in-container executor. */
  containerId?: string | null;
}

/**
 * Is this finding proof that the path does not serve?
 *
 * The ONE place the precedence between the filesystem and HTTP halves is decided,
 * shared by every consumer (the deploy veto, the deploy warning, the compose
 * warning, the dashboard hint) so they cannot disagree about what "broken" means:
 *
 *   - `checked:false` → no signal. Never broken.
 *   - `served === false` → the edge really answered 404/5xx. Strongest evidence.
 *   - `served === true` → the edge really serves it. OVERRIDES a missing index:
 *     with `cleanUrls`, `try_files $uri.html` resolves `/about` with no index.html
 *     at all, so the filesystem rule alone reported a phantom failure.
 *   - `served` absent → fall back to the filesystem rule exactly as before, which
 *     is what keeps every pre-existing record reading the same way.
 */
export function outputFindingIsBroken(f: OutputCheckResult): boolean {
  if (!f.checked) return false;
  if (!f.found) return true;
  if (f.served === false) return true;
  // A REDIRECT is not evidence that anything serves. The probe used to be answered
  // 301 by the HTTP→HTTPS upgrade in the :80 block — which returns before the doc
  // root is consulted — and `statusIsServed` maps 3xx to served, so this override
  // turned a correct "root exists but holds no index" verdict into a healthy one.
  // The probe now sends `X-Forwarded-Proto: https` so it reaches the serve path; this
  // is the belt to that braces, and it also covers a redirect from any other cause.
  //
  // ONLY 3xx loses the override. 401/403 keep it deliberately: those mean a policy
  // answered a route that RESOLVED (basic auth, an edge rules guard), and with
  // cleanUrls there is legitimately no index.html behind it — so treating them as
  // broken would raise a false alarm on a site behaving exactly as configured.
  const redirected = f.status !== undefined && f.status >= 300 && f.status < 400;
  return !f.hasIndex && !(f.served === true && !redirected);
}

/** One human-readable reason per broken finding. Shared for the same reason the
 *  predicate is: the deploy log, the deploy warning and the compose warning
 *  should describe an identical verdict identically. */
export function describeOutputFinding(f: OutputCheckResult): string {
  if (f.served === false) {
    return `${f.path}: the edge answered HTTP ${f.status ?? "error"} — this path does not serve.`;
  }
  if (!f.found) {
    return `${f.path}: nothing at ${f.servedPath ?? "the routed path"} — this path will 404.`;
  }
  // Names index.html on purpose: this is the most common static 404 and the fix is
  // almost always the Output Directory pointing one level too shallow (Angular
  // `dist/<app>/browser`, Remix `build/client`).
  return `${f.path}: ${f.servedPath ?? "the routed path"} exists but has no index.html — this path will 404.`;
}

/**
 * Probe each target. Returns one result per target, in order.
 * Guaranteed to resolve (never rejects).
 */
export async function auditStaticOutput(
  source: OutputAuditSource,
  targets: StaticOutputTarget[],
  logger: BuildLogger,
): Promise<OutputCheckResult[]> {
  if (targets.length === 0) return [];

  const inconclusive = (reason: OutputCheckResult["skippedReason"]): OutputCheckResult[] =>
    targets.map((t) => ({
      path: t.path,
      servedPath: t.servedPath,
      found: false,
      hasIndex: false,
      checked: false,
      skippedReason: reason,
    }));

  const probe = await resolveProbe(source);
  if (!probe) return inconclusive("no-exec");

  const results: OutputCheckResult[] = [];
  for (const target of targets) {
    // Guard PER TARGET: one unreadable path must not discard the readings we
    // already have for the others.
    const r = await probe(target.servedPath, {
      hostname: target.hostname,
      requestPath: target.path,
    }).catch(() => null);
    if (!r) {
      results.push({
        path: target.path,
        servedPath: target.servedPath,
        found: false,
        hasIndex: false,
        checked: false,
        skippedReason: "no-exec",
      });
      continue;
    }
    const finding: OutputCheckResult = {
      path: target.path,
      servedPath: target.servedPath,
      found: r.found,
      hasIndex: r.hasIndex,
      checked: r.checked,
      ...(r.status === undefined ? {} : { status: r.status }),
      ...(r.served === undefined ? {} : { served: r.served }),
    };
    if (outputFindingIsBroken(finding)) {
      // "Found but no index" is the single most common static 404: the doc-root
      // exists (so deploy-time validation passed) with the real index one level
      // deeper (Angular `dist/<app>/browser`, Remix `build/client`). It is reported
      // only when the edge did not prove otherwise — see outputFindingIsBroken.
      logger.log(
        `Output check: ${describeOutputFinding(finding)} Check the Output Directory.\n`,
        "warn",
      );
    }
    results.push(finding);
  }
  return results;
}

type StaticProbe = (
  servedPath: string,
  opts?: StaticProbeOptions,
) => Promise<OutputProbeResult>;

/** The one place the vantage point is chosen. Returns null when nothing can probe. */
async function resolveProbe(source: OutputAuditSource): Promise<StaticProbe | null> {
  const routing = source.routing;
  if (routing?.probeStaticRoot) {
    return (servedPath, opts) => routing.probeStaticRoot!(servedPath, opts);
  }
  // No file-serving provider (cloud Pages, noop) → fall back to the deployment
  // itself, which is right for a bare static where the app and the files share a
  // filesystem. No HTTP half here: this executor is inside the WORKLOAD, not the
  // edge, so a loopback request from it would not reach the edge's listener.
  const { runtime, containerId } = source;
  if (!runtime?.inContainerExecutor || !containerId) return null;
  try {
    const executor = await runtime.inContainerExecutor(containerId);
    return (servedPath) => probeStaticOutput(executor, servedPath);
  } catch {
    return null;
  }
}
