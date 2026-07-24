/**
 * Per-server `.openship/manifest.json` — a structural, secret-free mirror of
 * the projects deployed to a given server, written over SSH at deploy time.
 *
 * Why: in DESKTOP mode the orchestrator DB (pglite) lives on the user's PC and
 * dies with it. The deployments themselves keep running on the user's servers,
 * so each server carries this manifest to let a fresh orchestrator SCAN the
 * server and re-adopt its projects (rebuild rows, re-link the live containers
 * by `openship.project` label). Mirrors the mail-state-on-VPS pattern.
 *
 * Invariants:
 *   - The orchestrator DB is ALWAYS canonical. This file is a best-effort
 *     mirror refreshed at deploy; reconcile only repopulates a fresh/empty
 *     orchestrator (or surfaces drift), never overrides live DB rows.
 *   - NO secrets. Env vars / credentials are never written here — reconcile
 *     restores structure; secrets come from a backup or are re-entered.
 *   - Written ONLY in desktop mode (see the gate at the call site).
 */

import type { CommandExecutor } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import type { DatabaseDump } from "@repo/db";
import {
  OPENSHIP_DIR,
  readOpenshipFile,
  writeOpenshipFile,
  removeOpenshipFile,
  openshipFileExists,
} from "./openship-server-store";

/** Bare filename within the shared `.openship/` dir; folder + atomic-write
 *  mechanics live in openship-server-store. */
const MANIFEST_FILE = "manifest.json";
/** Full path — for log messages only. */
export const MANIFEST_PATH = `${OPENSHIP_DIR}/${MANIFEST_FILE}`;
const MANIFEST_VERSION = 1;

export interface ManifestDeployment {
  id: string;
  containerId?: string | null;
  imageRef?: string | null;
  status?: string;
  meta?: Record<string, unknown> | null;
}

/** Structural project snapshot — NO secrets. */
export interface ManifestProjectEntry {
  id: string;
  slug: string;
  name: string;
  organizationId: string;
  groupId: string;
  appName?: string | null;
  appSlug?: string | null;
  gitProvider?: string | null;
  gitOwner?: string | null;
  gitRepo?: string | null;
  gitBranch?: string | null;
  runtimeMode?: string | null;
  autoDeploy?: boolean;
  environmentSlug?: string | null;
  domains: string[];
  deployment?: ManifestDeployment;
  updatedAt: string;
}

export interface OpenshipManifest {
  version: number;
  updatedAt: string;
  projects: ManifestProjectEntry[];
}

/**
 * Read the manifest over SSH. Returns null if absent / unparseable / a version
 * we don't understand (caller treats null as "no manifest").
 */
export async function readManifest(exec: CommandExecutor): Promise<OpenshipManifest | null> {
  const trimmed = await readOpenshipFile(exec, MANIFEST_FILE);
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as OpenshipManifest;
    if (parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.projects)) {
      console.warn(`[openship-manifest] ${MANIFEST_PATH} unrecognized shape/version — ignoring`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(`[openship-manifest] failed to parse ${MANIFEST_PATH}: ${safeErrorMessage(err)}`);
    return null;
  }
}

/**
 * Atomically write the manifest over SSH: temp file → `mv -f` (a kill mid-write
 * never leaves a half-flushed JSON). Mirrors mail-state's writeState.
 */
export async function writeManifest(exec: CommandExecutor, manifest: OpenshipManifest): Promise<void> {
  const next: OpenshipManifest = {
    ...manifest,
    version: MANIFEST_VERSION,
    updatedAt: new Date().toISOString(),
  };
  await writeOpenshipFile(exec, MANIFEST_FILE, JSON.stringify(next, null, 2));
}

/**
 * Read-merge-write: replace this project's entry (by id), preserve every other
 * project already in the manifest. So the file accumulates every project
 * deployed to this server.
 */
export async function upsertProjectIntoManifest(
  exec: CommandExecutor,
  entry: ManifestProjectEntry,
): Promise<void> {
  const current = (await readManifest(exec)) ?? {
    version: MANIFEST_VERSION,
    updatedAt: new Date().toISOString(),
    projects: [],
  };
  const projects = current.projects.filter((p) => p.id !== entry.id);
  projects.push(entry);
  await writeManifest(exec, { ...current, projects });
}

/**
 * Remove a project's entry (called on teardown so reconcile doesn't resurrect a
 * deleted project). No-op when the manifest or entry is absent.
 */
export async function removeProjectFromManifest(
  exec: CommandExecutor,
  projectId: string,
): Promise<void> {
  const current = await readManifest(exec);
  if (!current) return;
  const projects = current.projects.filter((p) => p.id !== projectId);
  if (projects.length === current.projects.length) return; // nothing to remove
  await writeManifest(exec, { ...current, projects });
}

// ─── Per-project full-subgraph snapshot ──────────────────────────────────────
//
// The manifest above is a lightweight structural INDEX (read during a scan for
// display). This is the full, secret-free `dumpSubgraph({kind:"project"})` — the
// exact DB rows (project + services + deployments + service_deployments + domains
// + env structure) — written beside it so re-import can `restoreSubgraph` the
// project FAITHFULLY instead of reconstructing it from live docker. Flat file
// (no subdir) so it reuses the atomic openship-file helpers verbatim.

/** `.openship/snapshot-<projectId>.json`. projectId is `proj_<alnum>` (safe
 *  filename) — enforce it here so a crafted id can never traverse the path or
 *  inject into the remote command that consumes this name. */
function snapshotFile(projectId: string): string {
  if (!/^proj_[A-Za-z0-9]+$/.test(projectId)) {
    throw new Error(`Refusing unsafe snapshot projectId: ${projectId}`);
  }
  return `snapshot-${projectId}.json`;
}

/** Write the full project-subgraph dump (secret-free) to the server. */
export async function writeProjectSnapshot(
  exec: CommandExecutor,
  projectId: string,
  dump: DatabaseDump,
): Promise<void> {
  await writeOpenshipFile(exec, snapshotFile(projectId), JSON.stringify(dump));
}

/** Read + parse a project snapshot. Null when absent / unparseable / wrong shape. */
export async function readProjectSnapshot(
  exec: CommandExecutor,
  projectId: string,
): Promise<DatabaseDump | null> {
  const raw = await readOpenshipFile(exec, snapshotFile(projectId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DatabaseDump;
    if (parsed?.scope?.kind !== "project" || !parsed.tables) return null;
    return parsed;
  } catch (err) {
    console.warn(`[openship-snapshot] failed to parse snapshot for ${projectId}: ${safeErrorMessage(err)}`);
    return null;
  }
}

/** Cheap existence check (no read) — is a snapshot available for this project? */
export async function projectSnapshotExists(
  exec: CommandExecutor,
  projectId: string,
): Promise<boolean> {
  return openshipFileExists(exec, snapshotFile(projectId));
}

/** Delete a project's snapshot (teardown). Idempotent. */
export async function removeProjectSnapshot(
  exec: CommandExecutor,
  projectId: string,
): Promise<void> {
  await removeOpenshipFile(exec, snapshotFile(projectId));
}
