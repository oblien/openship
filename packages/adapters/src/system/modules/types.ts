/**
 * Native-module migration catalog — types.
 *
 * A signed, per-module catalog describes ordered, run-once migrations for infra
 * installed on servers (OpenResty first). The catalog is authored/signed by
 * Openship (ed25519), pulled from a pinned GitHub ref (or the embedded fallback),
 * and VERIFIED before anything is written or executed on a target host. See
 * ./verify.ts for the trust gate and ./reconcile.ts for the runner.
 *
 * Design invariants carried from ensureLuaScripts (openresty-lua.ts): never-throw
 * at the apply layer, stamp-last so a crash resumes rather than lands "current".
 */

import { FAMILY_BY_DISTRO, type DistroFamily } from "@repo/core";

/** Apply tier. `auto` converges with no operator click (additive/safe changes);
 *  `consent` requires an explicit Update and surfaces `warning` first. Unspecified
 *  defaults to `consent` (fail-safe: nothing runs unattended unless marked auto). */
export type ApplyTier = "auto" | "consent";

interface StepBase {
  /** Stable, unique-within-module id. The run-once ledger key — NEVER reuse or
   *  renumber once shipped, or boxes that already ran it will skip a new step. */
  id: string;
  /** Per-step override of the version's tier. Defaults to the version's `apply`. */
  apply?: ApplyTier;
  /** Human-readable heads-up shown before a `consent` apply ("this drops X"). */
  warning?: string;
  /**
   * Optional family filter. Absent = applies everywhere (the .sh asset is expected
   * to branch internally).
   *
   * A FAMILY, not a distro id: a step that works on Rocky works on Alma, RHEL, Oracle
   * and Amazon Linux, and enumerating them by id meant every new RPM derivative was
   * silently outside every filter.
   *
   * The union catches a bad filter for an author writing TypeScript; it catches nothing
   * in a catalog, which arrives as JSON. `validateModuleVersion` is the real gate.
   */
  distroFamily?: readonly DistroFamily[];
}

/** Write a verified asset to an absolute path on the box (content-addressed:
 *  skipped when the on-box file already hashes to `sha256`). */
export interface FileStep extends StepBase {
  kind: "file";
  /** Absolute destination path on the target host. */
  path: string;
  /** Catalog-relative asset key (e.g. "assets/1.0.0/rules_guard.lua"). */
  asset: string;
  /** Required sha256 (hex) of the asset bytes — the tamper gate. */
  sha256: string;
  /** Octal mode string, e.g. "0644". Default 0644. */
  mode?: string;
}

/** Run a verified .sh script on the box (only AFTER signature + hash pass). The
 *  script is distro-aware at runtime; args are shell-quoted with `sq`. */
export interface ExecStep extends StepBase {
  kind: "exec";
  /** Catalog-relative asset key of the .sh script. */
  asset: string;
  /** Required sha256 (hex) of the script bytes — the tamper gate. */
  sha256: string;
  /** Positional args passed to the script (each single-quoted via `sq`). */
  args?: string[];
}

export type ModuleStep = FileStep | ExecStep;

export interface ModuleVersion {
  /** Semver, e.g. "1.1.0". */
  version: string;
  /** Optional floor: skip this version if the on-box version is below `minFrom`
   *  (used when a migration is only valid from a certain baseline). */
  minFrom?: string;
  /** Default tier for this version's steps (a step may override). */
  apply: ApplyTier;
  /** Version-level warning surfaced before a `consent` apply. */
  warning?: string;
  /** Ordered steps. Applied in array order; each `id` recorded once run. */
  steps: ModuleStep[];
}

export interface ModuleCatalog {
  /** Module identity, e.g. "openresty". */
  module: string;
  /** Catalog schema version (bump only on breaking shape changes). */
  schema: 1;
  /** Monotonic counter. Anti-rollback: a box refuses a catalog whose serial is
   *  below its recorded high-water mark, so an old (validly-signed) catalog can't
   *  be replayed to downgrade. */
  serial: number;
  /** Highest available version (semver). */
  latest: string;
  /** All published versions (unordered here; the runner sorts by semver). */
  versions: ModuleVersion[];
}

/** A catalog whose signature + asset hashes have been verified, paired with the
 *  raw asset bytes keyed by their catalog-relative `asset` key. Only a value of
 *  this type may reach the reconcile runner. */
export interface VerifiedCatalog {
  catalog: ModuleCatalog;
  /** asset key → verified bytes. */
  assets: Map<string, Buffer>;
  /** Provenance for the on-box manifest (pinned ref / "embedded"). */
  ref: string;
}

/** Resolve a step's effective tier (step override → version default). */
export function effectiveTier(version: ModuleVersion, step: ModuleStep): ApplyTier {
  return step.apply ?? version.apply;
}

// ─── Runtime shape validation ────────────────────────────────────────────────

/**
 * The interfaces above are an authoring aid. A catalog reaches the runner as JSON
 * (catalog-source.ts parses and casts), so a signature proves only WHO wrote the
 * payload — never that its values are members of these unions.
 *
 * The gap had teeth: `"distroFamily":["redhat"]` — the member is `"rhel"` — verified,
 * matched no host, skipped on every RPM box, and let the version marker advance. The
 * fleet reported itself converged having run nothing. So every value the runner
 * branches on is re-checked here, and an unrecognized one FAILS rather than skips.
 */

/**
 * Families a real host can resolve to, read off core's `distro → family` map so this
 * file holds no second copy of the member list — a second list is the original bug.
 * `unknown` is absent by construction (core excludes it) and is not targetable: a step
 * gated to `unknown` could never legitimately match a host.
 */
const TARGETABLE_FAMILIES: ReadonlySet<string> = new Set<DistroFamily>(
  Object.values(FAMILY_BY_DISTRO),
);

/** Total over `ApplyTier`: a new tier without an entry here is a compile error. */
const APPLY_TIERS: Record<ApplyTier, true> = { auto: true, consent: true };

const familyList = () => [...TARGETABLE_FAMILIES].sort().join("/");
const tierList = () => Object.keys(APPLY_TIERS).join("/");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isName = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Quote the observed value into a reason. Never throws, never yields "undefined". */
function shown(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** `hasOwn`, not `in`: `in` walks the prototype, so `"toString"` would read as a tier. */
const isTier = (v: unknown): v is ApplyTier =>
  typeof v === "string" && Object.hasOwn(APPLY_TIERS, v);

/**
 * Is this a family a real host can resolve to?
 *
 * Used on BOTH sides of the distro gate — the step's filter and the host's own resolved
 * family — because "this host is not in the allowlist" and "nobody can tell what this
 * host is" are different answers and only one of them may skip.
 */
export function isTargetableFamily(value: unknown): value is DistroFamily {
  return typeof value === "string" && TARGETABLE_FAMILIES.has(value);
}

/**
 * A version string the runner can ORDER. `compareSemver` reads anything unparseable as
 * 0.0.0, so a typo'd version doesn't error — it sorts below every box and vanishes from
 * the pending set. `v1.2.0` and `1.2.0-rc.1` are refused for the same reason: the suffix
 * is ignored on compare, so two entries would order identically.
 */
function semverError(what: string, value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value.trim())) {
    return `${what} must be a semver string like "1.2.0" (got ${shown(value)})`;
  }
  return null;
}

function familyFilterError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    // `[]` matches nothing on every host — indistinguishable from the typo it usually is.
    return `distroFamily must be a non-empty array of ${familyList()} (got ${shown(value)})`;
  }
  for (const entry of value) {
    if (!isTargetableFamily(entry)) {
      return `distroFamily names ${shown(entry)}, which is not a distro family (known: ${familyList()})`;
    }
  }
  return null;
}

function stepError(raw: unknown): string | null {
  if (!isRecord(raw)) return `step is not an object (got ${shown(raw)})`;
  if (!isName(raw.id)) return `step id must be a non-empty string (got ${shown(raw.id)})`;
  const at = `step ${shown(raw.id)}`;

  if (raw.apply !== undefined && !isTier(raw.apply)) {
    // An unrecognized tier reads as "not consent" and would run unattended.
    return `${at}: apply must be ${tierList()} (got ${shown(raw.apply)})`;
  }
  if (raw.warning !== undefined && typeof raw.warning !== "string") {
    return `${at}: warning must be a string (got ${shown(raw.warning)})`;
  }
  const familyError = familyFilterError(raw.distroFamily);
  if (familyError) return `${at}: ${familyError}`;

  if (!isName(raw.asset)) return `${at}: asset must be a non-empty string (got ${shown(raw.asset)})`;
  if (typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(raw.sha256)) {
    return `${at}: sha256 must be 64 hex chars (got ${shown(raw.sha256)})`;
  }

  if (raw.kind === "file") {
    if (!isName(raw.path) || !raw.path.startsWith("/")) {
      return `${at}: path must be absolute (got ${shown(raw.path)})`;
    }
    if (raw.mode !== undefined && (typeof raw.mode !== "string" || !/^[0-7]{3,4}$/.test(raw.mode))) {
      return `${at}: mode must be an octal string like "0644" (got ${shown(raw.mode)})`;
    }
    return null;
  }
  if (raw.kind === "exec") {
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== "string"))) {
      return `${at}: args must be an array of strings (got ${shown(raw.args)})`;
    }
    return null;
  }
  return `${at}: kind must be "file" or "exec" (got ${shown(raw.kind)})`;
}

/**
 * The catalog-level facts that decide WHAT runs, checked before the runner picks a
 * pending set. Unorderable is worse than invalid here: a typo'd `latest` reads as 0.0.0,
 * filters every version out, and the box comes back "converged" having applied nothing.
 *
 * Step shape is deliberately NOT checked here — that's `validateModuleVersion`, per
 * version, so one unrunnable future version doesn't block the valid ones before it.
 */
export function validateModuleCatalog(raw: unknown): string | null {
  if (!isRecord(raw)) return `catalog is not an object (got ${shown(raw)})`;
  // Breaking shape changes bump `schema`; a runner that only speaks 1 must refuse a 2
  // rather than execute the half of it that happens to parse.
  if (raw.schema !== 1) return `catalog schema must be 1 (got ${shown(raw.schema)})`;
  const latestError = semverError("catalog latest", raw.latest);
  if (latestError) return latestError;
  // Anti-rollback compares this against the on-box high-water mark; a non-number makes
  // every comparison false, which reads as "no rollback here".
  if (typeof raw.serial !== "number" || !Number.isInteger(raw.serial) || raw.serial < 0) {
    return `catalog serial must be a non-negative integer (got ${shown(raw.serial)})`;
  }
  if (!Array.isArray(raw.versions)) {
    return `catalog versions must be an array (got ${shown(raw.versions)})`;
  }
  for (const entry of raw.versions) {
    if (!isRecord(entry)) return `catalog versions holds a non-object entry (got ${shown(entry)})`;
    const idError = semverError("catalog version", entry.version);
    if (idError) return idError;
  }
  return null;
}

/**
 * Total validator for one catalog version and every step in it. `null` = safe to run;
 * otherwise a reason naming the offending field and the value observed.
 *
 * Whole-version, checked before the first step of that version touches the box: a typo
 * in step 3 must not leave steps 1-2 applied and the version half-migrated. Shape is
 * knowable without contacting the host, unlike an exec that fails on arrival.
 */
export function validateModuleVersion(raw: unknown): string | null {
  if (!isRecord(raw)) return `version is not an object (got ${shown(raw)})`;
  const idError = semverError("version", raw.version);
  if (idError) return idError;
  const at = `version ${shown(raw.version)}`;
  if (raw.minFrom !== undefined) {
    const minFromError = semverError(`${at}: minFrom`, raw.minFrom);
    if (minFromError) return minFromError;
  }
  if (raw.warning !== undefined && typeof raw.warning !== "string") {
    return `${at}: warning must be a string (got ${shown(raw.warning)})`;
  }
  // Required, not optional: every step with no `apply` of its own inherits this one.
  if (!isTier(raw.apply)) return `${at}: apply must be ${tierList()} (got ${shown(raw.apply)})`;
  if (!Array.isArray(raw.steps)) return `${at}: steps must be an array (got ${shown(raw.steps)})`;
  for (const step of raw.steps) {
    const error = stepError(step);
    if (error) return `${at}: ${error}`;
  }
  return null;
}
