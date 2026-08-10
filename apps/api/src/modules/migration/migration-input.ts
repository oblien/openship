/**
 * Pure sanitizers for the migration controller's request bodies. Extracted so
 * they can be unit-tested without the controller's heavy import graph (Hono,
 * the orchestrator, adapters). Each returns `undefined` when there's nothing
 * well-formed to forward, so the orchestrator sees a clean optional field.
 */

/** A per-service route to publish post-verify. `targetPath` (e.g. "/v3") marks a
 *  service that serves a PATH of a shared domain (path fan-out); its absence
 *  means the root `/`. */
export interface MigrationRouteSpec {
  exposedPort?: string;
  domainType: "free" | "custom";
  domain?: string;
  customDomain?: string;
  targetPath?: string;
}

/** Normalize a location path prefix to a leading-slash form (`v3` → `/v3`),
 *  rejecting `..` traversal; `/` or empty → "/". Inlined (not imported from
 *  public-endpoints) to keep this module import-light for its unit tests. */
function normalizePathPrefix(raw: string): string {
  const segments = raw
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== ".");
  if (segments.some((s) => s === "..")) return "/";
  return segments.length > 0 ? `/${segments.join("/")}` : "/";
}

/** Keep only well-formed serviceName → "reuse"|"copy" entries from client input. */
export function sanitizeVolumeStrategies(
  input: Record<string, unknown> | undefined,
): Record<string, "reuse" | "copy"> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, "reuse" | "copy"> = {};
  for (const [name, v] of Object.entries(input)) {
    if (v === "copy" || v === "reuse") out[name] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Keep only serviceName → non-empty-string subpath entries from client input. */
export function sanitizeSubpaths(
  input: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(input)) {
    if (typeof v === "string" && v.trim()) out[name] = v.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Keep only discoveredServiceName → repoServiceName (non-empty string) entries;
 *  drops non-strings and no-op (identity) renames. Names the adopted row after
 *  the mapped repo compose service so the later reconcile matches it in place. */
export function sanitizeRenames(
  input: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(input)) {
    if (typeof v === "string" && v.trim() && v.trim() !== name) out[name] = v.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Keep only serviceName → {KEY: string} env maps from client input (per-service
 *  env overrides). Drops non-object entries and non-string values. */
export function sanitizeServiceEnv(
  input: Record<string, unknown> | undefined,
): Record<string, Record<string, string>> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, Record<string, string>> = {};
  for (const [name, env] of Object.entries(input)) {
    if (!env || typeof env !== "object" || Array.isArray(env)) continue;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (k && typeof v === "string") clean[k] = v;
    }
    out[name] = clean; // keep even if empty — an explicit "cleared all env" override
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Keep only well-formed {source, dest} custom-path entries: both must be
 *  absolute paths (start with "/"), no "..", trimmed. Caps at 50 to bound the
 *  move. Returns undefined when nothing valid. */
export function sanitizeCustomPaths(
  input: unknown,
): Array<{ source: string; dest: string }> | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: Array<{ source: string; dest: string }> = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { source?: unknown; dest?: unknown };
    const source = typeof e.source === "string" ? e.source.trim() : "";
    const dest = typeof e.dest === "string" ? e.dest.trim() : "";
    if (!source.startsWith("/") || !dest.startsWith("/")) continue;
    if (source.includes("..") || dest.includes("..")) continue;
    out.push({ source, dest });
    if (out.length >= 50) break;
  }
  return out.length > 0 ? out : undefined;
}

/** serviceName → conflict resolution ∈ override|clone|keep. Caps at 100. */
export function sanitizeConflictResolution(
  input: Record<string, unknown> | undefined,
): Record<string, "override" | "clone" | "keep"> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, "override" | "clone" | "keep"> = {};
  for (const [name, v] of Object.entries(input)) {
    if (v === "override" || v === "clone" || v === "keep") out[name] = v;
    if (Object.keys(out).length >= 100) break;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Keep only well-formed per-service route specs (serviceName → domain/route),
 *  published server-side post-verify. Caps at 100 services. */
export function sanitizeRoutes(
  input: Record<string, unknown> | undefined,
):
  | Record<string, MigrationRouteSpec>
  | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, MigrationRouteSpec> = {};
  for (const [name, raw] of Object.entries(input)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as {
      exposedPort?: unknown;
      domainType?: unknown;
      domain?: unknown;
      customDomain?: unknown;
      targetPath?: unknown;
    };
    const domainType = r.domainType === "custom" ? "custom" : "free";
    const domain = typeof r.domain === "string" ? r.domain.trim().toLowerCase() : undefined;
    const customDomain =
      typeof r.customDomain === "string" ? r.customDomain.trim().toLowerCase() : undefined;
    const value = domainType === "custom" ? customDomain : domain;
    if (!value) continue; // nothing to publish without a domain
    // A non-root location prefix (e.g. "/v3") → this service serves a PATH of the
    // domain (path fan-out); root ("/") is the default and carries no targetPath.
    const path = typeof r.targetPath === "string" ? normalizePathPrefix(r.targetPath) : undefined;
    out[name] = {
      domainType,
      ...(domainType === "custom" ? { customDomain: value } : { domain: value }),
      ...(r.exposedPort != null && String(r.exposedPort).trim()
        ? { exposedPort: String(r.exposedPort).trim() }
        : {}),
      ...(path && path !== "/" ? { targetPath: path } : {}),
    };
    if (Object.keys(out).length >= 100) break;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Validate the optional project-level git source (v1: GitHub only). */
export function sanitizeGitSource(
  input: unknown,
): { provider: "github"; owner: string; repo: string; branch?: string } | undefined {
  if (!input || typeof input !== "object") return undefined;
  const g = input as { provider?: unknown; owner?: unknown; repo?: unknown; branch?: unknown };
  if (g.provider !== "github") return undefined;
  const owner = typeof g.owner === "string" ? g.owner.trim() : "";
  const repo = typeof g.repo === "string" ? g.repo.trim() : "";
  if (!owner || !repo) return undefined;
  const branch = typeof g.branch === "string" && g.branch.trim() ? g.branch.trim() : undefined;
  return { provider: "github", owner, repo, branch };
}
