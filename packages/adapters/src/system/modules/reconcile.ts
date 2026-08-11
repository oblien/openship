/**
 * Native-module reconcile runner — applies a VERIFIED catalog's pending
 * migrations to one server, in semver order, run-once, stamp-last, never-throw.
 *
 * Generalizes ensureLuaScripts (openresty-lua.ts): instead of one content-hash
 * marker + rewrite-all, it walks ordered versions, applies each step once
 * (recorded by id), and persists the manifest AFTER each success so a crash
 * resumes at the last good step rather than landing falsely "current".
 *
 * Tiering: `mode:"auto"` applies only steps whose effective tier is `auto`
 * (additive/safe); a `consent` step stops auto convergence and is reported as
 * pending so an operator can apply it explicitly (`mode:"all"`).
 *
 * SECURITY: `catalog` MUST already be signature+hash verified (see verify.ts /
 * catalog-source.ts). Bytes come from the verified asset map; nothing is fetched
 * or trusted here. Interpolated args are single-quoted with `sq`.
 */

import { compareSemver } from "@repo/core";
import type { CommandExecutor } from "../../types";
import type { EnvironmentProfile } from "../environment";
import { sq } from "../../runtime/git-clone";
import { effectiveTier, type ModuleVersion, type ModuleStep, type VerifiedCatalog } from "./types";
import {
  readManifestOrSeed,
  writeManifest,
  type OnBoxManifest,
} from "./on-box-manifest";

export interface ReconcileOptions {
  module: string;
  profile: EnvironmentProfile;
  /** Already signature + hash verified. */
  catalog: VerifiedCatalog;
  /** "auto" = only apply:auto steps (unattended); "all" = include consent steps. */
  mode: "auto" | "all";
  /** Baseline seed for boxes predating this framework (e.g. legacy lua marker). */
  seed?: { legacyMarkerPath: string; baselineVersion: string };
  dryRun?: boolean;
  onLog?: (line: string) => void;
  /** Runs once after any change lands (e.g. openresty -t + reload). Best-effort. */
  postApply?: (executor: CommandExecutor) => Promise<void>;
}

export interface PendingConsent {
  id: string;
  version: string;
  warning?: string;
}

export interface ReconcileResult {
  module: string;
  fromVersion: string;
  toVersion: string;
  appliedSteps: string[];
  pendingConsent: PendingConsent[];
  skipped: string[];
  changed: boolean;
  ok: boolean;
  error?: string;
}

function log(opts: ReconcileOptions, line: string): void {
  opts.onLog?.(`[module:${opts.module}] ${line}`);
}

/** True when the on-box file at `path` already hashes to `sha256`. */
async function onBoxFileMatches(
  executor: CommandExecutor,
  path: string,
  sha256: string,
): Promise<boolean> {
  try {
    const out = await executor.exec(`sha256sum ${sq(path)} 2>/dev/null | awk '{print $1}'`);
    return out.trim().toLowerCase() === sha256.toLowerCase();
  } catch {
    return false; // missing file / no sha256sum → treat as mismatch (will write)
  }
}

async function applyStep(
  executor: CommandExecutor,
  opts: ReconcileOptions,
  step: ModuleStep,
): Promise<{ applied: boolean; skipped: boolean }> {
  const bytes = opts.catalog.assets.get(step.asset);
  if (!bytes) {
    // Verified catalogs guarantee assets exist; treat a gap as a hard error.
    throw new Error(`asset ${step.asset} not present in verified catalog`);
  }

  if (step.kind === "file") {
    if (await onBoxFileMatches(executor, step.path, step.sha256)) {
      log(opts, `skip file ${step.path} (already current)`);
      return { applied: false, skipped: true };
    }
    log(opts, `${opts.dryRun ? "[dry-run] " : ""}write ${step.path}`);
    if (!opts.dryRun) {
      await executor.writeFile(step.path, bytes.toString("utf8"));
      if (step.mode) await executor.exec(`chmod ${sq(step.mode)} ${sq(step.path)}`);
    }
    return { applied: true, skipped: false };
  }

  // exec: write the verified script to a temp path, run with the author's own
  // `set -eu`, propagate the exit code, always clean up.
  const safeId = step.id.replace(/[^A-Za-z0-9._-]/g, "_");
  const tmp = `/tmp/openship-mig-${opts.module}-${safeId}.sh`;
  const argStr = (step.args ?? []).map(sq).join(" ");
  log(opts, `${opts.dryRun ? "[dry-run] " : ""}exec ${step.asset}${argStr ? ` ${argStr}` : ""}`);
  if (opts.dryRun) return { applied: true, skipped: false };

  await executor.writeFile(tmp, bytes.toString("utf8"));
  const cmd =
    `chmod 700 ${sq(tmp)} && sh ${sq(tmp)}${argStr ? ` ${argStr}` : ""}; ` +
    `rc=$?; rm -f ${sq(tmp)}; exit $rc`;
  const { code } = await executor.streamExec(cmd, (l) => opts.onLog?.(l.message ?? String(l)));
  if (code !== 0) throw new Error(`exec step ${step.id} failed (exit ${code})`);
  return { applied: true, skipped: false };
}

/**
 * Apply the pending migrations of `catalog` to the box. Never throws — any
 * failure returns `ok:false` with the partial progress already persisted.
 */
export async function reconcileServerModule(
  executor: CommandExecutor,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const { catalog } = opts.catalog;
  const applied: string[] = [];
  const skipped: string[] = [];
  const pendingConsent: PendingConsent[] = [];
  let changed = false;

  const result = (over: Partial<ReconcileResult>, manifest: OnBoxManifest): ReconcileResult => ({
    module: opts.module,
    fromVersion: manifest.migrationVersion,
    toVersion: manifest.migrationVersion,
    appliedSteps: applied,
    pendingConsent,
    skipped,
    changed,
    ok: true,
    ...over,
  });

  let manifest: OnBoxManifest;
  try {
    manifest = await readManifestOrSeed(executor, opts.module, opts.seed);
  } catch (err) {
    return {
      module: opts.module,
      fromVersion: "unknown",
      toVersion: "unknown",
      appliedSteps: [],
      pendingConsent: [],
      skipped: [],
      changed: false,
      ok: false,
      error: `read manifest failed: ${(err as Error).message}`,
    };
  }
  const fromVersion = manifest.migrationVersion;

  try {
    // Anti-rollback: refuse a catalog whose serial is below what we've applied.
    if (manifest.catalogSerial != null && catalog.serial < manifest.catalogSerial) {
      return {
        ...result({}, manifest),
        fromVersion,
        ok: false,
        error: `catalog serial ${catalog.serial} < on-box high-water ${manifest.catalogSerial} (refusing downgrade)`,
      };
    }

    // Only versions strictly newer than the box, up to `latest`, ascending.
    const pending = [...catalog.versions]
      .filter(
        (v) =>
          compareSemver(v.version, manifest.migrationVersion) > 0 &&
          compareSemver(v.version, catalog.latest) <= 0,
      )
      .sort((a, b) => compareSemver(a.version, b.version));

    for (const version of pending) {
      // minFrom gap check against the running (already-advanced) version.
      if (version.minFrom && compareSemver(manifest.migrationVersion, version.minFrom) < 0) {
        return {
          ...result({}, manifest),
          fromVersion,
          ok: false,
          error: `version ${version.version} requires minFrom ${version.minFrom}, box at ${manifest.migrationVersion}`,
        };
      }

      let versionComplete = true;
      for (const step of version.steps) {
        if (manifest.appliedSteps.includes(step.id)) {
          skipped.push(step.id);
          continue;
        }
        // Distro filter: not applicable on this box → skip without recording.
        if (step.distro && !step.distro.includes(opts.profile.distro ?? "")) {
          skipped.push(step.id);
          continue;
        }
        // Tier gate: a consent step halts auto convergence (can't complete the
        // version), and every later version is blocked too.
        if (effectiveTier(version, step) === "consent" && opts.mode === "auto") {
          pendingConsent.push({ id: step.id, version: version.version, warning: step.warning ?? version.warning });
          versionComplete = false;
          break;
        }

        const { applied: didApply } = await applyStep(executor, opts, step);
        if (didApply) {
          changed = true;
          applied.push(step.id);
        } else {
          skipped.push(step.id);
        }
        // Stamp-last, per step: record the id even for a skipped-because-current
        // file so we don't re-check it forever.
        if (!opts.dryRun) {
          manifest = {
            ...manifest,
            appliedSteps: [...manifest.appliedSteps, step.id],
            catalogSerial: Math.max(manifest.catalogSerial ?? 0, catalog.serial),
            catalogRef: opts.catalog.ref,
          };
          await writeManifest(executor, manifest);
        }
      }

      if (!versionComplete) break; // gated on consent — stop advancing
      // Whole version applied → advance the version marker (stamp-last).
      if (!opts.dryRun) {
        manifest = { ...manifest, migrationVersion: version.version };
        await writeManifest(executor, manifest);
      }
    }

    if (changed && !opts.dryRun && opts.postApply) {
      try {
        await opts.postApply(executor);
      } catch (err) {
        log(opts, `postApply failed (non-fatal): ${(err as Error).message}`);
      }
    }

    return { ...result({}, manifest), fromVersion };
  } catch (err) {
    // Never throw: return the partial progress already persisted.
    return {
      ...result({}, manifest),
      fromVersion,
      ok: false,
      error: (err as Error).message,
    };
  }
}
