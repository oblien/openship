/**
 * In-app updater for the packaged desktop app.
 *
 * Cycle: checkForUpdate() (GitHub latest release vs app.getVersion()) →
 * downloadUpdate() (streams the platform installer with progress) →
 * installUpdate() (seamless self-replace + relaunch).
 *
 * We download the installer and swap the app ourselves (not Squirrel.Mac, which
 * requires signing). A detached script does the swap because a running app can't
 * overwrite its own bundle.
 *
 * Trust: the release feed and every download redirect are pinned. The installer
 * must match its checksum AND an Ed25519 signature binding its version, name and
 * digest to the publisher key embedded in this app. Missing proofs fail closed.
 */

import { app, net, shell } from "electron";
import {
  changelogMarkdownUrl,
  extractChangelogSection,
  resolveDesktopUpdate,
  RELEASES_LATEST_API,
  type DesktopUpdateAsset,
  type DesktopUpdateCheck,
  type DesktopUpdateSnapshot,
  type GithubReleasePayload,
} from "@repo/core";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { advisoryManifestUrl, parseManifest, type AdvisoryManifest } from "@repo/core";
import { isAllowedUpdateAssetUrl } from "./security";
import { verifyUpdateSignature } from "./update-signature";

export type UpdateAsset = DesktopUpdateAsset;
export type UpdateInfo = Extract<DesktopUpdateCheck, { available: true }>;
export type UpdateCheck = DesktopUpdateSnapshot;

let cachedCheck: UpdateCheck | null = null;
let inFlightCheck: Promise<UpdateCheck> | null = null;

/** Startup, renderer navigation and manual checks share one request in flight. */
export function checkForUpdate(options: { force?: boolean } = {}): Promise<UpdateCheck> {
  if (inFlightCheck) return inFlightCheck;
  if (!options.force && cachedCheck) return Promise.resolve(cachedCheck);
  inFlightCheck = checkForUpdateUncached()
    .then((result) => {
      // Offline is not a successful session cache: allow the next caller to retry.
      cachedCheck = result.latest ? result : null;
      return result;
    })
    .finally(() => {
      inFlightCheck = null;
    });
  return inFlightCheck;
}

/**
 * Ask GitHub for the latest release, then read the changelog and advisory
 * manifest pinned to its tag before handing the result to
 * `resolveDesktopUpdate`. Never throws — a failed release check (offline,
 * rate-limited) resolves to "no update".
 *
 * This function is I/O only. The whole decision — which asset this platform
 * pulls, whether the release is newer, and whether an advisory authorizes
 * interrupting the user — lives in @repo/core, unit-tested against synthetic
 * payloads. Nothing here re-checks or re-derives any of it.
 */
async function checkForUpdateUncached(): Promise<UpdateCheck> {
  try {
    const res = await net.fetch(RELEASES_LATEST_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Openship-Desktop",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { available: false, latest: null, manifest: null };
    const data = (await res.json()) as GithubReleasePayload;
    const tag = (data?.tag_name ?? "").trim();
    if (!tag) return { available: false, latest: null, manifest: null };
    // These are independent, fail-soft reads. A missing changelog must never
    // suppress a critical advisory (or the reverse).
    const [manifest, changelogNotes] = await Promise.all([fetchManifest(tag), fetchChangelog(tag)]);
    return {
      ...resolveDesktopUpdate({
        releasePayload: data,
        platform: process.platform,
        arch: process.arch,
        currentVersion: app.getVersion(),
        manifest,
        changelogNotes,
      }),
      latest: { version: tag.replace(/^v/, ""), tag, notes: changelogNotes ?? "" },
      manifest,
    };
  } catch {
    return { available: false, latest: null, manifest: null };
  }
}

/** Exact release section from the immutable changelog at this release tag. */
async function fetchChangelog(tag: string): Promise<string | null> {
  if (!tag) return null;
  try {
    const res = await net.fetch(changelogMarkdownUrl(tag), {
      headers: { Accept: "text/markdown", "User-Agent": "Openship-Desktop" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return extractChangelogSection(await res.text(), tag);
  } catch {
    return null;
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
  version: string,
  onProgress: (fraction: number) => void,
): Promise<string> {
  // The release feed comes from the pinned repo, but the asset URL inside it was
  // previously followed wherever it pointed — so a tampered feed could source the
  // installer from any host. Pin it to GitHub's own release hosts.
  const expectedUrl = `https://github.com/oblien/openship/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(asset.name)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(asset.name) || asset.url !== expectedUrl || !isAllowedUpdateAssetUrl(asset.url)) {
    throw new Error(`Refusing to download update from untrusted URL: ${asset.url}`);
  }

  const dir = mkdtempSync(join(app.getPath("temp"), "openship-update-"));
  const dest = join(dir, asset.name);
  try {
    await downloadVerifiedInstaller(asset, version, onProgress, dest);
    return dest;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

async function downloadVerifiedInstaller(asset: UpdateAsset, version: string, onProgress: (fraction: number) => void, dest: string): Promise<void> {
  const res = await fetchUpdateAsset(asset.url, AbortSignal.timeout(10 * 60_000));
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }

  const total = Number(res.headers.get("content-length")) || asset.size || 0;
  const file = await open(dest, "wx", 0o600);
  const reader = res.body.getReader();
  const hash = createHash("sha256");
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      await file.writeFile(value);
      received += value.length;
      if (total > 0) onProgress(Math.min(1, received / total));
    }
  } finally {
    await file.close();
    await reader.cancel();
  }

  // Integrity gate: verify the sha256 sidecar the release publishes, and FAIL
  // CLOSED. A mismatch and a missing sidecar are both refusals — treating absence
  // as "install anyway" made the check bypassable by whoever could swap the asset,
  // which is the only attacker it defends against. release.yml publishes a sidecar
  // for every desktop artifact, and the sidecar is always read from the release
  // we're installing, so failing closed can't strand a real release.
  //
  // The independent publisher signature below supplies authenticity as well.
  const digest = hash.digest("hex");
  let expected: string | null = null;
  let sidecarError = "unreachable";
  try {
    const shaRes = await fetchUpdateAsset(`${asset.url}.sha256`, AbortSignal.timeout(10_000));
    if (!shaRes.ok) sidecarError = `HTTP ${shaRes.status}`;
    else {
      const tok = (await readUpdateProof(shaRes)).trim().split(/\s+/)[0]?.toLowerCase();
      if (tok && /^[0-9a-f]{64}$/.test(tok)) expected = tok;
      else sidecarError = "malformed";
    }
  } catch {
    sidecarError = "unreachable";
  }
  if (!expected) {
    rmSync(dest, { force: true });
    throw new Error(
      `Update integrity check failed — no usable .sha256 for ${asset.name} (${sidecarError}). Refusing to install.`,
    );
  }
  if (expected !== digest) {
    rmSync(dest, { force: true });
    throw new Error(
      `Update checksum mismatch — refusing to install ${asset.name} (expected ${expected}, got ${digest}).`,
    );
  }
  try {
    const signature = await fetchUpdateAsset(`${asset.url}.sig`, AbortSignal.timeout(10_000));
    if (!signature.ok) throw new Error("No publisher signature");
    verifyUpdateSignature(JSON.parse(await readUpdateProof(signature)), { version, name: asset.name, sha256: digest });
  } catch {
    rmSync(dest, { force: true });
    throw new Error("Update signature is missing or invalid. Refusing to install this update.");
  }
}

/** Validate each redirect before issuing the next request, including sidecars. */
async function fetchUpdateAsset(input: string, signal: AbortSignal): Promise<Response> {
  let url = input;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!isAllowedUpdateAssetUrl(url)) throw new Error("Untrusted update download destination.");
    const response = await net.fetch(url, { redirect: "manual", signal, headers: { "User-Agent": "Openship-Desktop" } });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const next = response.headers.get("location");
    if (!next) throw new Error("Update redirect has no destination.");
    url = new URL(next, url).href;
  }
  throw new Error("Too many update redirects.");
}

async function readUpdateProof(response: Response): Promise<string> {
  if (!response.body) throw new Error("Missing update proof.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks).toString("utf8");
      size += value.length;
      if (size > 4096) throw new Error("Invalid update proof size.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
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
  const attach = spawnSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-noverify", dmg], {
    encoding: "utf8",
  });
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
