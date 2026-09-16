/**
 * Compose-service `environment` and `buildArgs` masking (#336, #854).
 *
 * A compose service's env and build-arg maps are BOTH the deploy spec AND
 * display data. They routinely hold secrets (DB passwords, API
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
import { fingerprintBuildArgs } from "./build-arg-fingerprint";
export { ENV_MASK, isMaskedValue };

/**
 * Return a copy of an env map with every value replaced by the mask sentinel.
 * Blanket masking (decision on #336): zero false negatives, no secret can leak
 * through an unusual key name. Non-secret config is revealed on demand instead.
 */
export function maskEnv(env: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  for (const key of Object.keys(env)) out[key] = maskValue(env[key]);
  return out;
}

/** Null build args inherit from the build environment; empty strings stay empty. */
export function maskBuildArgs(args: Record<string, string | null> | null | undefined) {
  return Object.fromEntries(
    Object.entries(args ?? {}).map(([key, value]) => [
      key,
      value === null ? null : maskValue(value),
    ]),
  );
}

/** Whole-map replacement, like buildArgs before masking, with sentinel recovery. */
export function unmaskBuildArgs(
  incoming: Record<string, string | null> | null | undefined,
  stored: Record<string, string | null> | null | undefined,
): Record<string, string | null> {
  // fromEntries defines own properties safely (including `__proto__`) while
  // retaining a normal object prototype for the database's JSON serializer.
  return Object.fromEntries(
    Object.entries(incoming ?? {}).flatMap(([key, value]) => {
      if (!isMaskedValue(value)) return [[key, value]];
      return stored && Object.hasOwn(stored, key) ? [[key, stored[key]]] : [];
    }),
  );
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
 *
 * This is the right helper when the caller genuinely owns the WHOLE set — create,
 * compose sync, and the migration/deploy paths, which each rebuild the map from an
 * upstream spec and must be able to drop a variable the spec no longer declares.
 * The PATCH endpoint wants `mergeServiceEnv` below instead: a partial body there
 * would otherwise delete every variable it merely failed to mention.
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

/**
 * Merge an incoming compose-service `environment` patch onto what's stored,
 * preserving untouched variables and restoring masked secrets (#336, #619).
 *
 * Runtime environment edits are partial, and reveal is deliberately off the
 * automation surface — so a client cannot see
 * what a whole-map replace is about to destroy, and cannot read it back. Omission
 * therefore has to mean "keep", and removal has to be explicit. Same triad as
 * `mergeAdvanced`, plus the sentinel arm that only a masked field needs:
 *
 *   - key absent from patch  → leave the stored value alone
 *   - key value === null     → remove it
 *   - key value === ENV_MASK → keep the stored value (dropped if not in stored)
 *   - key value === string   → update/insert that key
 *   - incoming === null      → clear the entire environment map
 *   - incoming === undefined → leave the stored map alone
 */
export function mergeServiceEnv(
  stored: Record<string, string> | null | undefined,
  incoming: Record<string, string | null | undefined> | null | undefined,
): Record<string, string> {
  if (incoming === null) return {};
  if (incoming === undefined || typeof incoming !== "object" || Array.isArray(incoming)) {
    return { ...(stored ?? {}) };
  }
  const base: Record<string, string> = { ...(stored ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null) {
      delete base[key];
    } else if (isMaskedValue(value)) {
      if (stored && Object.hasOwn(stored, key)) {
        base[key] = stored[key];
      } else {
        delete base[key];
      }
    } else if (typeof value === "string") {
      base[key] = value;
    }
  }
  return base;
}

/** Whether an env map contains any mask sentinel (i.e. an un-revealed value). */
export function hasMaskedValue(env: Record<string, string | null> | null | undefined): boolean {
  if (!env) return false;
  return Object.values(env).some(isMaskedValue);
}

/**
 * Mask the env and build-arg fields of a single compose/deployable service. Returns a
 * shallow copy — the caller's stored object is left untouched. It also removes
 * server-owned interpolation provenance before the service crosses an API
 * boundary, even when the service has no runtime environment map.
 */
export function maskServiceEnv<
  T extends {
    name?: string;
    projectId?: string;
    buildArgs?: Record<string, string | null> | null;
    importedSpec?: unknown;
    driftSpec?: unknown;
    environment?: Record<string, string> | null;
    environmentTemplates?: Record<string, string> | null;
    advanced?: {
      imageTemplate?: unknown;
      environmentTemplateKeys?: string[];
      environmentOverrideKeys?: string[];
      buildArgTemplateKeys?: string[];
      [key: string]: unknown;
    } | null;
  },
>(
  svc: T | null | undefined,
  projectId?: string,
): (T & { buildArgsFingerprints?: Record<string, string> }) | null | undefined {
  if (!svc) return svc;
  if (
    !svc.environment &&
    !svc.buildArgs &&
    !svc.importedSpec &&
    !svc.driftSpec &&
    !svc.environmentTemplates &&
    !svc.advanced?.imageTemplate &&
    !svc.advanced?.environmentTemplateKeys &&
    !svc.advanced?.environmentOverrideKeys
  ) {
    return svc;
  }
  // `environmentTemplates` is transient parser provenance. Its expressions can
  // contain literal defaults, so never serialize it even though the persisted
  // raw copy is already protected by blanket environment masking.
  const {
    environmentTemplates: _templates,
    importedSpec: _importedSpec,
    driftSpec: _driftSpec,
    ...publicService
  } = svc;
  const advanced = svc.advanced ? { ...svc.advanced } : svc.advanced;
  if (advanced) {
    // Parser provenance is server-owned. Besides preventing a client from
    // forging resolution state, stripping the raw expressions avoids exposing
    // literal defaults embedded in `${VAR:-value}` through read APIs.
    delete advanced.imageTemplate;
    delete advanced.environmentTemplateKeys;
    delete advanced.environmentOverrideKeys;
  }
  return {
    ...publicService,
    ...(svc.environment ? { environment: maskEnv(svc.environment) } : {}),
    ...(svc.buildArgs ? { buildArgs: maskBuildArgs(svc.buildArgs) } : {}),
    ...(svc.buildArgs && (projectId || svc.projectId) && svc.name
      ? {
          buildArgsFingerprints: fingerprintBuildArgs(
            (projectId || svc.projectId)!,
            svc.name,
            svc.buildArgs,
            svc.advanced?.buildArgTemplateKeys,
          ),
        }
      : {}),
    ...(advanced !== undefined ? { advanced } : {}),
  } as T;
}

/** Map `maskServiceEnv` over a list, tolerating null/undefined. */
export function maskServicesEnv<
  T extends {
    environment?: Record<string, string> | null;
    environmentTemplates?: Record<string, string> | null;
    advanced?: { environmentTemplateKeys?: string[]; [key: string]: unknown } | null;
  },
>(svcs: T[] | null | undefined, projectId?: string): T[] {
  if (!svcs) return [];
  // Elements are concrete services, so the masked result is never null/undefined.
  return svcs.map((s) => maskServiceEnv(s, projectId) as T);
}

/** The value-bearing fields of a compose `environmentMeta` entry. */
interface EnvMetaLike {
  source?: string;
  variable?: string;
  defaultValue?: string;
  resolvedValue?: string;
  expression?: string;
  required?: boolean;
  unresolvedVariables?: string[];
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
  return publicEnvironmentMeta(meta, false);
}

function publicEnvironmentMeta(
  meta: Record<string, EnvMetaLike> | null | undefined,
  includeEnv: boolean,
): Record<string, EnvMetaLike> {
  const out: Record<string, EnvMetaLike> = {};
  if (!meta) return out;
  for (const [key, m] of Object.entries(meta)) {
    out[key] = {
      ...(m.source !== undefined && { source: m.source }),
      ...(m.variable !== undefined && { variable: m.variable }),
      ...(m.required !== undefined && { required: m.required }),
      ...(m.unresolvedVariables !== undefined && {
        unresolvedVariables: [...m.unresolvedVariables],
      }),
      ...(m.resolvedValue !== undefined && {
        resolvedValue: includeEnv ? m.resolvedValue : maskValue(m.resolvedValue),
      }),
      ...(m.defaultValue !== undefined && {
        defaultValue: includeEnv ? m.defaultValue : maskValue(m.defaultValue),
      }),
    };
  }
  return out;
}

/**
 * Project scan data for an API response. Source values are masked by default;
 * authorized editing scans may include them in the initial response. Parser
 * provenance stays server-owned in either case.
 */
export function publicScanService<
  T extends {
    buildArgs?: Record<string, string | null> | null;
    environment?: Record<string, string> | null;
    environmentTemplates?: Record<string, string> | null;
    environmentMeta?: Record<string, EnvMetaLike> | null;
    advanced?: {
      imageTemplate?: unknown;
      environmentTemplateKeys?: string[];
      [key: string]: unknown;
    } | null;
  },
>(svc: T, includeEnv = false): T {
  // svc is always a concrete service here (mapped from a scan list).
  const masked = maskServiceEnv(svc) as T;
  return {
    ...masked,
    ...(includeEnv && svc.environment && { environment: { ...svc.environment } }),
    ...(includeEnv && svc.buildArgs && { buildArgs: { ...svc.buildArgs } }),
    ...(svc.environmentMeta && {
      environmentMeta: publicEnvironmentMeta(svc.environmentMeta, includeEnv),
    }),
  };
}

/** Retain the masking-only helper used by other read boundaries. */
export function maskScanService<T extends Parameters<typeof publicScanService>[0]>(svc: T): T {
  return publicScanService(svc);
}

/**
 * Mask the compose-service env carried in a deployment's `meta` snapshot
 * (`meta.composeServices[].environment` and `buildArgs`). Returns a copy — the stored row/meta
 * is untouched (rollback/redeploy read the real values back). Apply at the
 * shared presentation boundary: `getDeployment` is also used internally and must
 * use the decrypted repository values. No-op when there's no `meta.composeServices`.
 */
export function maskDeploymentEnv<T extends { meta?: unknown } | null | undefined>(dep: T): T {
  if (
    !dep ||
    typeof dep !== "object" ||
    !("meta" in dep) ||
    !dep.meta ||
    typeof dep.meta !== "object"
  ) {
    return dep;
  }
  const meta = dep.meta as Record<string, unknown>;
  if (!Array.isArray(meta.composeServices)) return dep;
  return {
    ...dep,
    meta: {
      ...meta,
      composeServices: maskServicesEnv(
        meta.composeServices as { environment?: Record<string, string> | null }[],
        (dep as { projectId?: string }).projectId,
      ),
    },
  };
}

/**
 * Mask value-bearing provenance in a `composeSpecDiff()` result so the drift UI
 * never renders secrets from environment maps or Compose image defaults. Other
 * fields (image, ports, readiness, …) pass through unchanged.
 */
export function maskDriftChanges<T extends { field: string; from: unknown; to: unknown }>(
  changes: T[] | null | undefined,
): T[] {
  if (!changes) return [];
  return changes.map((c) => {
    if (c.field === "environment") {
      return {
        ...c,
        from: maskEnv(c.from as Record<string, string> | null),
        to: maskEnv(c.to as Record<string, string> | null),
      };
    }
    if (c.field === "buildArgs") {
      return {
        ...c,
        from: maskBuildArgs(c.from as Record<string, string | null> | null),
        to: maskBuildArgs(c.to as Record<string, string | null> | null),
      };
    }
    if (c.field === "advanced") {
      const maskImageTemplate = (value: unknown): unknown => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value;
        const advanced = { ...(value as Record<string, unknown>) };
        const template = advanced.imageTemplate;
        if (template && typeof template === "object" && !Array.isArray(template)) {
          advanced.imageTemplate = {
            ...(template as Record<string, unknown>),
            expression: ENV_MASK,
            ...(Object.hasOwn(template, "sourceValue") && { sourceValue: ENV_MASK }),
          };
        }
        return advanced;
      };
      return { ...c, from: maskImageTemplate(c.from), to: maskImageTemplate(c.to) };
    }
    return c;
  });
}
