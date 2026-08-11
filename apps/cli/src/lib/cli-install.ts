/**
 * Distribution marker for the tarball-installed CLI, written by
 * scripts/install.sh (and install.ps1) at ~/.openship/cli-install.json and read
 * by `openship update` + the service backend.
 *
 * Its presence flips `openship update` from "reinstall the published npm/bun
 * package" to "re-download the verified payload tarball and repoint
 * cli/current" (lib/cli-payload.ts) — the Node-runtime distribution that
 * replaces `bun add -g openship`. Distinct from the `install-method` file
 * (compose vs bare), which is a SERVICE dimension, orthogonal to how the CLI
 * binary itself was delivered. Parallels lib/source-install.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OS_DIR } from "./paths";

export interface CliInstall {
  /** How the CLI binary was delivered. Only "tarball" today (curl | sh). */
  method: "tarball";
  /** Installed payload tag, e.g. "v0.5.0". */
  tag: string;
  /** Absolute path of the stable launcher the service's ExecStart points at. */
  launcher: string;
  /** Which node the launcher resolves at runtime. */
  runtime: "system" | "vendored";
}

const MARKER = join(OS_DIR, "cli-install.json");

export function parseCliInstall(raw: string): CliInstall | null {
  try {
    const obj = JSON.parse(raw) as Partial<CliInstall>;
    if (!obj || obj.method !== "tarball" || typeof obj.tag !== "string" || !obj.tag) return null;
    return {
      method: "tarball",
      tag: obj.tag,
      launcher: typeof obj.launcher === "string" ? obj.launcher : join(OS_DIR, "bin", "openship"),
      runtime: obj.runtime === "vendored" ? "vendored" : "system",
    };
  } catch {
    return null;
  }
}

/** The tarball-install marker, or null when the CLI came from npm/bun/source. */
export function readCliInstall(): CliInstall | null {
  if (!existsSync(MARKER)) return null;
  try {
    return parseCliInstall(readFileSync(MARKER, "utf8"));
  } catch {
    return null;
  }
}

/** Persist the marker (used by `openship update` to record the new tag/runtime). */
export function writeCliInstall(info: CliInstall): void {
  mkdirSync(OS_DIR, { recursive: true });
  writeFileSync(MARKER, `${JSON.stringify(info, null, 2)}\n`);
}
