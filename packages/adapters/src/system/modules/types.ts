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
  /** Optional distro filter, matched against EnvironmentProfile.distro. Absent =
   *  applies on every distro (the .sh asset is expected to branch internally). */
  distro?: string[];
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
