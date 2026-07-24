/**
 * Pure sanitizers for the migration controller's request bodies. Extracted so
 * they can be unit-tested without the controller's heavy import graph (Hono,
 * the orchestrator, adapters). Each returns `undefined` when there's nothing
 * well-formed to forward, so the orchestrator sees a clean optional field.
 */

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
