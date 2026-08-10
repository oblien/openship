/**
 * Compose-service `environment` masking (#336).
 *
 * A compose service's `environment` map is BOTH the deploy spec (injected into
 * the container) AND display data. It routinely holds secrets (DB passwords, API
 * tokens), yet — unlike project env vars, which carry an explicit `isSecret`
 * flag — it's a flat `Record<string,string>` with no secret marker. So instead
 * of a fragile key-name heuristic we mask *every* value on output and offer an
 * explicit, write-gated reveal.
 *
 * The rules:
 *   - MASK ON OUTPUT ONLY. Never mutate the stored row / deployment meta — the
 *     pipeline and rollback read the real values back. Mask a *copy*.
 *   - UNMASK-MERGE ON WRITE. When a client echoes the mask sentinel back (it
 *     round-trips the value it was shown), treat it as "unchanged" and restore
 *     the stored plaintext, so an edit never overwrites a secret with dots.
 *
 * This mirrors the `••••••••` masking the project/service env-var endpoints
 * already do (project-env.service.ts, service.service.ts listServiceEnvVars).
 */

// The mask sentinel + predicate live in @repo/core so the dashboard's env editor
// shares the exact same string (the reveal/round-trip contract depends on it).
import { ENV_MASK, isMaskedValue } from "@repo/core";
export { ENV_MASK, isMaskedValue };

/**
 * Return a copy of an env map with every value replaced by the mask sentinel.
 * Blanket masking (decision on #336): zero false negatives, no secret can leak
 * through an unusual key name. Non-secret config is revealed on demand instead.
 */
export function maskEnv(
  env: Record<string, string> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  for (const key of Object.keys(env)) out[key] = maskValue(env[key]);
  return out;
}

/**
 * An EMPTY value stays empty — there is nothing there to hide, and dots in its
 * place are an active lie: the wizard reads "no value" off the empty string to
 * flag a variable as needing one (`${VAR:?…}`, #472). Masking it showed the user
 * a filled-looking secret field for a variable that was in fact unset, and the
 * write path then unmask-merged the sentinel straight back to empty.
 */
function maskValue(value: string): string {
  return value === "" ? "" : ENV_MASK;
}

/**
 * Merge a client-supplied env map back over the stored one, treating the mask
 * sentinel as "keep the stored value". Used on every write path that accepts
 * `environment` so a masked value echoed back from the UI never clobbers the
 * real secret.
 *
 *   - incoming value === ENV_MASK  → use `stored[key]` (dropped if the stored
 *     map has no such key — a sentinel with nothing behind it is never persisted)
 *   - otherwise                    → use the incoming (real / newly-typed) value
 *
 * Keys absent from `incoming` are absent from the result: a full-map write still
 * deletes keys the client removed. Callers that only want partial semantics must
 * pre-merge (this is a whole-map replace with sentinel protection).
 */
export function unmaskEnv(
  incoming: Record<string, string> | null | undefined,
  stored: Record<string, string> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!incoming) return out;
  const base = stored ?? {};
  for (const [key, value] of Object.entries(incoming)) {
    if (isMaskedValue(value)) {
      if (key in base) out[key] = base[key];
      // else: sentinel with no stored counterpart → drop (never persist "••••••••")
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Whether an env map contains any mask sentinel (i.e. an un-revealed value). */
export function hasMaskedValue(
  env: Record<string, string> | null | undefined,
): boolean {
  if (!env) return false;
  return Object.values(env).some(isMaskedValue);
}

/**
 * Mask the `environment` field of a single compose/deployable service. Returns a
 * shallow copy — the caller's stored object is left untouched. Anything without
 * an `environment` map passes through unchanged.
 */
export function maskServiceEnv<T extends { environment?: Record<string, string> | null }>(
  svc: T | null | undefined,
): T | null | undefined {
  if (!svc || !svc.environment) return svc;
  return { ...svc, environment: maskEnv(svc.environment) };
}

/** Map `maskServiceEnv` over a list, tolerating null/undefined. */
export function maskServicesEnv<T extends { environment?: Record<string, string> | null }>(
  svcs: T[] | null | undefined,
): T[] {
  if (!svcs) return [];
  // Elements are concrete services, so the masked result is never null/undefined.
  return svcs.map((s) => maskServiceEnv(s) as T);
}

/** The value-bearing fields of a compose `environmentMeta` entry. */
interface EnvMetaLike {
  source?: string;
  variable?: string;
  defaultValue?: string;
  resolvedValue?: string;
  expression?: string;
  required?: boolean;
}

/**
 * Mask a compose `environmentMeta` map. Keeps the structural fields (`source`,
 * `variable` — the variable NAME, not its value, and `required`) so the scan UI
 * can still show where a value resolved from, but strips every value-bearing
 * field (`resolvedValue`, `defaultValue`, `expression` — a `${VAR:-secret}`
 * default embeds the value) so a secret can't leak through the metadata.
 */
export function maskEnvironmentMeta(
  meta: Record<string, EnvMetaLike> | null | undefined,
): Record<string, EnvMetaLike> {
  const out: Record<string, EnvMetaLike> = {};
  if (!meta) return out;
  for (const [key, m] of Object.entries(meta)) {
    out[key] = {
      ...(m.source !== undefined && { source: m.source }),
      ...(m.variable !== undefined && { variable: m.variable }),
      ...(m.required !== undefined && { required: m.required }),
      ...(m.resolvedValue !== undefined && { resolvedValue: maskValue(m.resolvedValue) }),
      ...(m.defaultValue !== undefined && { defaultValue: maskValue(m.defaultValue) }),
    };
  }
  return out;
}

/**
 * Mask a scan-result service: both its `environment` map and its
 * `environmentMeta` value fields. Used for the scan/prepare response, where the
 * service carries the extra `environmentMeta` the deployable/service rows don't.
 */
export function maskScanService<
  T extends {
    environment?: Record<string, string> | null;
    environmentMeta?: Record<string, EnvMetaLike> | null;
  },
>(svc: T): T {
  // svc is always a concrete service here (mapped from a scan list).
  const masked = maskServiceEnv(svc) as T;
  if (masked.environmentMeta) {
    return { ...masked, environmentMeta: maskEnvironmentMeta(masked.environmentMeta) };
  }
  return masked;
}

/**
 * Mask the compose-service env carried in a deployment's `meta` snapshot
 * (`meta.composeServices[].environment`). Returns a copy — the stored row/meta
 * is untouched (rollback/redeploy read the real values back). Apply at the
 * CONTROLLER boundary only: `getDeployment` is also used internally and must
 * keep plaintext. No-op when there's no `meta.composeServices`.
 */
export function maskDeploymentEnv<T extends { meta?: unknown } | null | undefined>(dep: T): T {
  if (!dep || typeof dep !== "object" || !("meta" in dep) || !dep.meta || typeof dep.meta !== "object") {
    return dep;
  }
  const meta = dep.meta as Record<string, unknown>;
  if (!Array.isArray(meta.composeServices)) return dep;
  return {
    ...dep,
    meta: { ...meta, composeServices: maskServicesEnv(meta.composeServices as { environment?: Record<string, string> | null }[]) },
  };
}

/**
 * Mask the `environment` entries of a `composeSpecDiff()` result so the drift UI
 * never renders the raw `from`/`to` secret maps. Only the `environment` field's
 * `from`/`to` are masked; all other fields (image, ports, …) pass through.
 */
export function maskDriftChanges<
  T extends { field: string; from: unknown; to: unknown },
>(changes: T[] | null | undefined): T[] {
  if (!changes) return [];
  return changes.map((c) =>
    c.field === "environment"
      ? {
          ...c,
          from: maskEnv(c.from as Record<string, string> | null),
          to: maskEnv(c.to as Record<string, string> | null),
        }
      : c,
  );
}
