/**
 * Advisory static-output audit — the file-side counterpart to port-audit.
 *
 * Confirms a static/path-based deployment actually has servable output at each
 * routed path. Purely advisory — it can NEVER throw or fail a deploy; the worst
 * it does is record `checked:false` so the dashboard stays silent.
 *
 * VANTAGE POINT is the whole design here, and it's decided once, below. A static
 * site is served by the EDGE reading a `root` path, so the only probe that
 * predicts a 404 is one taken where the edge looks. For a containerized edge the
 * vhost `root` is a HOST path that must be bind-mounted in — probe the host and
 * the files read as present while nginx sees an empty directory and 404s. So the
 * routing provider is asked first (it owns that knowledge), and the runtime's
 * in-container executor is only the fallback for providers that don't serve files.
 */

import {
  probeStaticOutput,
  resolveServedStaticPath,
  type BuildLogger,
  type OutputProbeResult,
  type Platform,
  type RuntimeAdapter,
} from "@repo/adapters";
import type { OutputCheckResult } from "../../lib/deployment-runtime";
import { normalizeTargetPath } from "../../lib/public-endpoints";

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
  endpoints: ReadonlyArray<{ targetPath?: string | null }>,
): Array<{ path: string; servedPath: string }> {
  const seen = new Set<string>();
  const targets: Array<{ path: string; servedPath: string }> = [];
  for (const endpoint of endpoints) {
    const path = normalizeTargetPath(endpoint.targetPath) ?? "/";
    if (seen.has(path)) continue;
    seen.add(path);
    targets.push({ path, servedPath: resolveServedStaticPath(staticRoot, path) });
  }
  if (targets.length === 0) targets.push({ path: "/", servedPath: staticRoot });
  return targets;
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
 * Probe each `{ path, servedPath }`. Returns one result per target.
 * Guaranteed to resolve (never rejects).
 */
export async function auditStaticOutput(
  source: OutputAuditSource,
  targets: Array<{ path: string; servedPath: string }>,
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
    const r = await probe(target.servedPath).catch(() => null);
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
    if (r.checked && !r.found) {
      logger.log(`Output check: nothing found at ${target.servedPath}.\n`, "warn");
    } else if (r.checked && !r.hasIndex) {
      // Found but unservable — the single most common static 404: the doc-root
      // exists (so deploy-time validation passed) with the real index one level
      // deeper (Angular `dist/<app>/browser`, Remix `build/client`).
      logger.log(
        `Output check: ${target.servedPath} exists but has no index.html — ` +
          `requests to ${target.path} will 404. Check the Output Directory.\n`,
        "warn",
      );
    }
    results.push({
      path: target.path,
      servedPath: target.servedPath,
      found: r.found,
      hasIndex: r.hasIndex,
      checked: r.checked,
    });
  }
  return results;
}

type StaticProbe = (servedPath: string) => Promise<OutputProbeResult>;

/** The one place the vantage point is chosen. Returns null when nothing can probe. */
async function resolveProbe(source: OutputAuditSource): Promise<StaticProbe | null> {
  const routing = source.routing;
  if (routing?.probeStaticRoot) {
    return (servedPath) => routing.probeStaticRoot!(servedPath);
  }
  // No file-serving provider (cloud Pages, noop) → fall back to the deployment
  // itself, which is right for a bare static where the app and the files share a
  // filesystem.
  const { runtime, containerId } = source;
  if (!runtime?.inContainerExecutor || !containerId) return null;
  try {
    const executor = await runtime.inContainerExecutor(containerId);
    return (servedPath) => probeStaticOutput(executor, servedPath);
  } catch {
    return null;
  }
}
