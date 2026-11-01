/**
 * On-box module manifest — the per-server, per-module record of what has been
 * migrated. Lives at /etc/openship/modules/<module>.json (sibling to the
 * FileStateStore's setup-state.json) and is read/written over the CommandExecutor
 * exactly like state.ts's FileStateStore, so it works on both local and SSH hosts.
 *
 * This generalizes the single `.openship-lua-version` content-hash marker
 * (openresty-lua.ts) into a real version + run-once ledger: `migrationVersion`
 * (last fully-applied catalog version), `appliedSteps` (ids already run — the
 * run-once key), and `catalogSerial` (anti-rollback high-water mark).
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type { CommandExecutor } from "../../types";

export interface OnBoxManifest {
  module: string;
  /** Last catalog version whose steps ALL applied successfully. "0.0.0" = fresh. */
  migrationVersion: string;
  /** Step ids already applied (run-once ledger). A recorded id is never re-run. */
  appliedSteps: string[];
  /** Detected native binary version (informational; e.g. openresty -v). */
  binaryVersion?: string;
  /** Provenance of the catalog last applied (pinned ref or "embedded"). */
  catalogRef?: string;
  /** Highest catalog serial ever applied — refuse a catalog below this. */
  catalogSerial?: number;
  /** ISO timestamp of the last write. */
  updatedAt?: string;
}

/** Directory holding one manifest per module. */
export const MODULES_STATE_DIR = "/etc/openship/modules";

export function manifestPath(module: string): string {
  return `${MODULES_STATE_DIR}/${module}.json`;
}

/** A fresh, never-migrated manifest for `module`. */
export function emptyManifest(module: string): OnBoxManifest {
  return { module, migrationVersion: "0.0.0", appliedSteps: [] };
}

/** Coerce a parsed blob into a well-formed manifest (defensive against edits). */
function normalize(module: string, raw: unknown): OnBoxManifest {
  const o = (raw ?? {}) as Partial<OnBoxManifest>;
  return {
    module,
    migrationVersion: typeof o.migrationVersion === "string" ? o.migrationVersion : "0.0.0",
    appliedSteps: Array.isArray(o.appliedSteps) ? o.appliedSteps.filter((s) => typeof s === "string") : [],
    binaryVersion: typeof o.binaryVersion === "string" ? o.binaryVersion : undefined,
    catalogRef: typeof o.catalogRef === "string" ? o.catalogRef : undefined,
    catalogSerial: typeof o.catalogSerial === "number" ? o.catalogSerial : undefined,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : undefined,
  };
}

/**
 * Read the on-box manifest for `module`, or null if none exists / is unreadable.
 * Never throws — a missing or corrupt manifest reads as "no record" so the runner
 * treats the box as fresh (idempotent steps then re-converge it).
 */
export async function readManifest(
  executor: CommandExecutor,
  module: string,
): Promise<OnBoxManifest | null> {
  const raw = await executor.readFile(manifestPath(module)).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "adapters/system/modules/on-box-manifest"); return ""; });
  if (!raw.trim()) return null;
  try {
    return normalize(module, JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Read the manifest, seeding a baseline when the box predates this framework: if
 * there's no manifest yet but `legacyMarkerPath` exists on the box (e.g. the old
 * `.openship-lua-version` from openresty-lua.ts), assume the box is already at
 * `baselineVersion` so we don't replay the baseline install against a live box.
 * The baseline's steps are content-addressed anyway, but seeding avoids needless
 * churn and any non-idempotent baseline exec.
 */
export async function readManifestOrSeed(
  executor: CommandExecutor,
  module: string,
  seed?: { legacyMarkerPath: string; baselineVersion: string },
): Promise<OnBoxManifest> {
  const existing = await readManifest(executor, module);
  if (existing) return existing;
  if (seed && (await executor.exists(seed.legacyMarkerPath).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "adapters/system/modules/on-box-manifest"); return false; }))) {
    return { module, migrationVersion: seed.baselineVersion, appliedSteps: [] };
  }
  return emptyManifest(module);
}

/**
 * Persist the manifest. `writeFile` creates parent dirs as needed. `updatedAt` is
 * stamped here. Callers write AFTER each step succeeds (stamp-last) so a crash
 * mid-migration leaves the box on the last good state, retried next run.
 */
export async function writeManifest(
  executor: CommandExecutor,
  manifest: OnBoxManifest,
): Promise<void> {
  const withTs: OnBoxManifest = { ...manifest, updatedAt: new Date().toISOString() };
  await executor.writeFile(manifestPath(manifest.module), `${JSON.stringify(withTs, null, 2)}\n`);
}
