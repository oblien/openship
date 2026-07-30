/**
 * In-app updater for the packaged desktop app.
 *
 * Cycle: checkForUpdate() (GitHub latest release vs app.getVersion()) →
 * downloadUpdate() (streams the platform installer with progress) →
 * installUpdate() (seamless self-replace + relaunch).
 *
 * No code signing needed: we download the installer and swap the app
 * ourselves (not Squirrel.Mac, which requires signing). A detached script
 * does the swap because a running app can't overwrite its own bundle.
 */

import { app, net, shell } from "electron";
import { resolveDesktopUpdate, type GithubReleasePayload } from "@repo/core";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { advisoryManifestUrl, parseManifest, type Advisory, type AdvisoryManifest } from "@repo/core";

const RELEASES_API = "https://api.github.com/repos/oblien/openship/releases/latest";

export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
}
export interface UpdateInfo {
  available: true;
  version: string;
  notes: string;
  asset: UpdateAsset;
  /**
   * The RELEASE ADVISORY that authorizes interrupting the user at launch, or
   * null for a routine release: installable from Settings → Updates, but no
   * modal, no notification. Comes straight from the advisory manifest via
   * `resolveDesktopUpdate` — this process never decides it for itself.
   */
  announcement: Advisory | null;
}
export type UpdateCheck = UpdateInfo | { available: false };

/**
 * Ask GitHub for the latest release + the advisory manifest pinned to its tag,
 * and hand both to `resolveDesktopUpdate`. Never throws — a failed check
 * (offline, rate-limited) resolves to "no update".
 *
 * This function is I/O only. The whole decision — which asset this platform
 * pulls, whether the release is newer, and whether an advisory authorizes
 * interrupting the user — lives in @repo/core, unit-tested against synthetic
 * payloads. Nothing here re-checks or re-derives any of it.
 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  try {
    const res = await net.fetch(RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Openship-Desktop",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { available: false };
    const data = (await res.json()) as GithubReleasePayload;
    return resolveDesktopUpdate({
      releasePayload: data,
      platform: process.platform,
      arch: process.arch,
      currentVersion: app.getVersion(),
      manifest: await fetchManifest((data?.tag_name ?? "").trim()),
    });
  } catch {
    return { available: false };
  }
}

/**
 * The advisory manifest for a release tag, validated through the same
 * `parseManifest` the dashboard uses (it's untrusted third-party JSON as far as
 * any client is concerned).
 *
 * Fails CLOSED: no tag, unreachable, or malformed → null → no announcement → we
 * stay quiet. A broken manifest must never become an unexpected modal on launch.
 */
async function fetchManifest(tag: string): Promise<AdvisoryManifest | null> {
  if (!tag) return null;
  try {
    const res = await net.fetch(advisoryManifestUrl(tag), {
      headers: { Accept: "application/json", "User-Agent": "Openship-Desktop" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return parseManifest(await res.json());
  } catch {
    return null;
  }
}

/** Download the asset to a temp file, reporting 0..1 progress. Returns the path. */
export async function downloadUpdate(
  asset: UpdateAsset,
  onProgress: (fraction: number) => void,
): Promise<string> {
  const dir = join(app.getPath("temp"), "openship-update");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, asset.name);

  const res = await net.fetch(asset.url, {
    headers: { "User-Agent": "Openship-Desktop" },
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }

  const total = Number(res.headers.get("content-length")) || asset.size || 0;
  const file = createWriteStream(dest);
  const reader = res.body.getReader();
  const hash = createHash("sha256");
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      if (!file.write(Buffer.from(value))) {
        await new Promise<void>((r) => file.once("drain", r));
      }
      received += value.length;
      if (total > 0) onProgress(Math.min(1, received / total));
    }
  } finally {
    file.end();
  }
  await new Promise<void>((r, j) => {
    file.on("finish", () => r());
    file.on("error", j);
  });

  // Integrity gate: verify the sha256 sidecar the release publishes. A MISMATCH
  // = corrupted/tampered download → refuse (delete + throw). A MISSING sidecar
  // is a warning, not a hard block (OS code-signing/Gatekeeper is the backstop),
  // so a release that omits it can never brick auto-update. Mirrors the CLI
  // dashboard bundle's verify, tuned to fail-open on absence.
  const digest = hash.digest("hex");
  let expected: string | null = null;
  try {
    const shaRes = await net.fetch(`${asset.url}.sha256`, {
      headers: { "User-Agent": "Openship-Desktop" },
      signal: AbortSignal.timeout(10_000),
    });
    if (shaRes.ok) {
      const tok = (await shaRes.text()).trim().split(/\s+/)[0]?.toLowerCase();
      if (tok && /^[0-9a-f]{64}$/.test(tok)) expected = tok;
    }
  } catch {
    /* sidecar unreachable → treat as absent (warn below) */
  }
  if (expected && expected !== digest) {
    rmSync(dest, { force: true });
    throw new Error(
      `Update checksum mismatch — refusing to install ${asset.name} (expected ${expected}, got ${digest}).`,
    );
  }
  if (!expected) {
    console.warn(`[updater] no .sha256 sidecar for ${asset.name}; skipping integrity check.`);
  }
  return dest;
}

/**
 * Apply the downloaded installer and relaunch on the new version. Quits the
 * app as its last step (the swap must happen while we're NOT running).
 */
export function installUpdate(file: string): void {
  try {
    if (process.platform === "darwin") return installMac(file);
    if (process.platform === "win32") return installWindows(file);
    return installLinux(file);
  } catch (err) {
    console.error("[updater] seamless install failed, opening installer:", err);
    fallbackOpen(file);
  }
}

/** Last resort: hand the installer to the OS and quit; user finishes it. */
function fallbackOpen(file: string): void {
  void shell.openPath(file);
  app.quit();
}

/** Spawn a detached script that waits for us to exit, then runs `body`. */
function runDetachedAfterExit(scriptBody: string, ext: "sh" | "cmd"): void {
  const dir = join(app.getPath("temp"), "openship-update");
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, `apply-update.${ext}`);
  writeFileSync(scriptPath, scriptBody, { mode: 0o755 });
  if (ext === "sh") chmodSync(scriptPath, 0o755);
  const child =
    ext === "sh"
      ? spawn("/bin/bash", [scriptPath], { detached: true, stdio: "ignore" })
      : spawn("cmd.exe", ["/c", scriptPath], { detached: true, stdio: "ignore" });
  child.unref();
  app.quit();
}

function installMac(dmg: string): void {
  // The running app bundle: <exe>/../../.. → …/Openship.app
  const installedApp = resolve(app.getPath("exe"), "..", "..", "..");
  if (!installedApp.endsWith(".app")) {
    return fallbackOpen(dmg);
  }

  const staged = join(app.getPath("temp"), "openship-update", "Openship.app");

  // Mount, copy the new .app out, unmount — all before we quit.
  const attach = spawnSync(
    "hdiutil",
    ["attach", "-nobrowse", "-readonly", "-noverify", dmg],
    { encoding: "utf8" },
  );
  if (attach.status !== 0) return fallbackOpen(dmg);
  const mount = (attach.stdout.match(/\/Volumes\/[^\n]*/g) ?? []).pop()?.trim();
  if (!mount) return fallbackOpen(dmg);

  try {
    const appInDmg = join(mount, "Openship.app");
    if (!existsSync(appInDmg)) return fallbackOpen(dmg);
    spawnSync("rm", ["-rf", staged]);
    const copy = spawnSync("ditto", [appInDmg, staged], { encoding: "utf8" });
    if (copy.status !== 0) return fallbackOpen(dmg);
  } finally {
    spawnSync("hdiutil", ["detach", mount, "-quiet"]);
  }

  // Wait for us to exit, then swap SAFELY: build the new bundle BESIDE the old
  // (a failed copy can't brick us — the old app is untouched), swap it in with
  // two atomic renames, and if the new bundle won't open, roll back to the
  // backup. The previous version did `rm -rf <live> && ditto` — a `ditto`
  // failure after the delete left NO app.
  runDetachedAfterExit(
    [
      "#!/bin/bash",
      `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.4; done`,
      `INSTALLED="${installedApp}"`,
      `STAGED="${staged}"`,
      `NEW="$INSTALLED.new"; BAK="$INSTALLED.bak"`,
      `rm -rf "$NEW" "$BAK"`,
      // Copy into place beside the old bundle first; on failure relaunch the
      // untouched old app and bail.
      `if ! ditto "$STAGED" "$NEW"; then open "$INSTALLED"; rm -rf "$NEW"; exit 0; fi`,
      // Atomic double-rename (same filesystem) — the install path is never empty
      // for more than a rename.
      `mv "$INSTALLED" "$BAK" && mv "$NEW" "$INSTALLED"`,
      // Relaunch; roll back to the backup if the new bundle fails to open.
      `if open "$INSTALLED"; then rm -rf "$BAK" "$STAGED"; else rm -rf "$INSTALLED"; mv "$BAK" "$INSTALLED"; open "$INSTALLED"; fi`,
      "",
    ].join("\n"),
    "sh",
  );
}

/** Find the directory under `root` that actually contains `file` (maker-zip
 *  nests the app under a top-level folder). Checks root, then one level down. */
function findDirContaining(root: string, file: string): string | null {
  if (existsSync(join(root, file))) return root;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(root, entry.name, file))) {
      return join(root, entry.name);
    }
  }
  return null;
}

function installWindows(zip: string): void {
  // The release pipeline ships a plain .zip (forge maker-zip, no Squirrel), so
  // we self-replace exactly like mac/linux: extract now, then a detached script
  // waits for us to exit (file locks), mirrors the new build over the install
  // dir, and relaunches.
  const installDir = dirname(app.getPath("exe")); // …\Openship-win32-x64\
  const staging = join(app.getPath("temp"), "openship-update", "win-extract");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  // Expand-Archive ships with Windows PowerShell; extract BEFORE quitting (as
  // installMac copies the .app out of the dmg first).
  const unzip = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${staging}'`,
    ],
    { encoding: "utf8" },
  );
  if (unzip.status !== 0) return fallbackOpen(zip);

  const appRoot = findDirContaining(staging, "openship.exe");
  if (!appRoot) return fallbackOpen(zip);

  // `robocopy /MIR` requires the target not be locked, so it runs only after we
  // exit. Exit codes 0-7 are success; the detached script is best-effort (mac/
  // linux scripts likewise don't gate on the copy result).
  runDetachedAfterExit(
    [
      "@echo off",
      ":wait",
      `tasklist /FI "PID eq ${process.pid}" | find "${process.pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)`,
      `robocopy "${appRoot}" "${installDir}" /MIR /NJH /NJS /NP /NFL /NDL >nul`,
      `start "" "${join(installDir, "openship.exe")}"`,
      `rmdir /s /q "${staging}"`,
      "",
    ].join("\r\n"),
    "cmd",
  );
}

function installLinux(appImage: string): void {
  const current = process.env.APPIMAGE;
  if (!current) return fallbackOpen(appImage);
  // Stage beside the live AppImage then atomic-rename — a `cp -f` straight over
  // the running file could leave a half-written, unlaunchable binary if it fails
  // mid-copy. On any failure the current AppImage is left untouched.
  runDetachedAfterExit(
    [
      "#!/bin/bash",
      `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.4; done`,
      `CUR="${current}"`,
      `if cp -f "${appImage}" "$CUR.new" && chmod +x "$CUR.new"; then mv -f "$CUR.new" "$CUR"; else rm -f "$CUR.new"; fi`,
      `"$CUR" &`,
      "",
    ].join("\n"),
    "sh",
  );
}
