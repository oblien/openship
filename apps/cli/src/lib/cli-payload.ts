/**
 * Download + verify + extract the arch-independent CLI payload for `openship
 * update` (tarball installs), and repoint ~/.openship/cli/current at it. The
 * payload (dist/ + node_modules/ + package.json) is built once by
 * build/stage-cli-payload.ts and published as openship-cli-<tag>.tar.gz; the
 * launcher runs cli/current/dist/index.js under Node.
 *
 * Mirrors lib/dashboard.ts's fail-closed verify + `tar -xzf` + `.extracted`
 * marker, but installs under ~/.openship/cli/<tag>/ (a live run target, not the
 * cache) so the current symlink can be repointed atomically on update.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { downloadToFile, parseSha256 } from "./cache";
import { assetUrl, expectedSha256, fetchSidecar, resolveLatestTag } from "./github-releases";
import { OS_DIR } from "./paths";

const CLI_DIR = join(OS_DIR, "cli");
const CLI_CURRENT = join(CLI_DIR, "current");

/** How many installed payloads to keep (current + one rollback) — the rest are
 *  pruned after a successful repoint. The in-use dir is always among the newest. */
const KEEP = 2;

export interface CliPayload {
  tag: string;
  /** ~/.openship/cli/<tag> */
  dir: string;
  /** dist/index.js the launcher execs. */
  entry: string;
}

function assetName(tag: string): string {
  return `openship-cli-${tag}.tar.gz`;
}

function repoint(link: string, targetTag: string): void {
  try {
    if (lstatSync(link)) rmSync(link, { recursive: true, force: true });
  } catch {
    /* no existing link */
  }
  // Relative target so the symlink survives a moved/renamed home.
  symlinkSync(targetTag, link, process.platform === "win32" ? "junction" : undefined);
}

/** Delete all but the newest KEEP tag dirs; never touch the current target. */
function prune(activeTag: string): void {
  let entries: string[];
  try {
    entries = readdirSync(CLI_DIR);
  } catch {
    return;
  }
  const tags = entries.filter((e) => e !== "current" && existsSync(join(CLI_DIR, e, ".extracted")));
  // Keep the newest KEEP by mtime; the active tag is always retained.
  const ranked = tags
    .map((t) => ({ t, m: safeMtime(join(CLI_DIR, t)) }))
    .sort((a, b) => b.m - a.m)
    .map((x) => x.t);
  const keep = new Set([activeTag, ...ranked.slice(0, KEEP)]);
  for (const t of tags) {
    if (!keep.has(t)) rmSync(join(CLI_DIR, t), { recursive: true, force: true });
  }
}

function safeMtime(p: string): number {
  try {
    return lstatSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Ensure the payload for `tag` is installed (download + verify + extract when
 * missing) and repoint cli/current at it. Fail-closed: a missing sidecar or a
 * checksum mismatch aborts and leaves the previous install intact.
 *
 * OPENSHIP_CLI_ASSET_URL overrides the download source (its `.sha256` sidecar is
 * fetched alongside) so a staged tarball installs without a published release.
 */
export async function ensureCliPayload(
  tag?: string,
  onProgress?: (received: number, total: number) => void,
): Promise<CliPayload> {
  const resolved = tag ?? (await resolveLatestTag());
  const dir = join(CLI_DIR, resolved);
  const entry = join(dir, "dist", "index.js");
  const marker = join(dir, ".extracted");

  if (existsSync(marker) && existsSync(entry)) {
    repoint(CLI_CURRENT, resolved);
    prune(resolved);
    return { tag: resolved, dir, entry };
  }

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const name = assetName(resolved);
  const override = process.env.OPENSHIP_CLI_ASSET_URL?.trim();
  const url = override || assetUrl(resolved, name);
  const tarball = join(dir, name);
  const { sha256 } = await downloadToFile(url, tarball, onProgress);

  const expected = override
    ? parseSha256((await fetchSidecar(`${url}.sha256`)) ?? "")
    : await expectedSha256(resolved, name);
  if (!expected) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`No .sha256 sidecar for ${name}; refusing to install an unverified CLI payload.`);
  }
  if (expected !== sha256) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`CLI payload checksum mismatch (expected ${expected}, got ${sha256}).`);
  }

  const untar = spawnSync("tar", ["-xzf", tarball, "-C", dir], { stdio: "inherit" });
  if (untar.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error("Failed to extract the CLI payload (is `tar` available?).");
  }
  rmSync(tarball, { force: true });

  if (!existsSync(entry)) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`CLI payload extracted but ${entry} is missing (unexpected layout).`);
  }
  writeFileSync(marker, `${resolved}\n`);
  repoint(CLI_CURRENT, resolved);
  prune(resolved);
  return { tag: resolved, dir, entry };
}
