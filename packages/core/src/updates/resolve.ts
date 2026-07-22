/**
 * Pure update-resolution logic shared by the desktop in-app updater
 * (apps/desktop/src/main/updater.ts) and the CLI `openship update` command.
 *
 * Kept here (no I/O, no Electron/Node-fs) so the exact asset-selection + version
 * gate is unit-testable with synthetic GitHub `releases/latest` payloads — the
 * single source of truth for "which installer asset does this platform pull".
 */

import { compareSemver } from "./semver";

/** The GitHub `releases/latest` fields we consume. */
export interface GithubReleasePayload {
  tag_name?: string;
  body?: string;
  assets?: Array<{ name: string; browser_download_url: string; size: number }>;
}

export interface DesktopUpdateAsset {
  name: string;
  url: string;
  size: number;
}

export type DesktopUpdateCheck =
  | { available: true; version: string; notes: string; asset: DesktopUpdateAsset }
  | { available: false };

/**
 * Installer asset name the release pipeline publishes for a platform/arch.
 * Must match `.github/workflows/release.yml` exactly: macOS ships per-arch dmgs,
 * Windows a single x64 zip (NOT a Squirrel Setup.exe — forge uses maker-zip),
 * Linux a per-arch AppImage — x64 keeps the legacy `Openship.AppImage` name
 * (so already-installed x64 clients keep auto-updating), arm64 is a distinct
 * asset. Returns null for an unknown platform.
 */
export function desktopAssetName(platform: string, arch: string): string | null {
  if (platform === "darwin") return arch === "arm64" ? "Openship-arm64.dmg" : "Openship-x64.dmg";
  if (platform === "win32") return "Openship-win32-x64.zip";
  if (platform === "linux") return arch === "arm64" ? "Openship-arm64.AppImage" : "Openship.AppImage";
  return null;
}

/**
 * Fold a `releases/latest` payload + platform/arch + current version into an
 * update decision. Available only when the release is strictly newer AND ships
 * an asset for this platform. Never throws.
 */
export function resolveDesktopUpdate(input: {
  releasePayload: GithubReleasePayload | null | undefined;
  platform: string;
  arch: string;
  currentVersion: string;
}): DesktopUpdateCheck {
  const { releasePayload, platform, arch, currentVersion } = input;
  const latest = (releasePayload?.tag_name ?? "").replace(/^v/, "");
  if (!latest || compareSemver(latest, currentVersion) <= 0) return { available: false };

  const wantName = desktopAssetName(platform, arch);
  if (!wantName) return { available: false };

  const asset = (releasePayload?.assets ?? []).find((a) => a.name === wantName);
  if (!asset) return { available: false };

  return {
    available: true,
    version: latest,
    notes: releasePayload?.body ?? "",
    asset: { name: asset.name, url: asset.browser_download_url, size: asset.size },
  };
}

// ─── CLI (`openship update`) ─────────────────────────────────────────────────

export type CliPackageManager = "bun" | "npm";

export type CliUpdatePlan =
  | { action: "up-to-date"; current: string; latest: string }
  | { action: "install"; current: string; latest: string };

/** Decide whether the globally-installed CLI needs updating. `latest` empty or
 *  not newer → up-to-date. */
export function resolveCliUpdatePlan(current: string, latest: string): CliUpdatePlan {
  const install = !!latest && compareSemver(latest, current) > 0;
  return { action: install ? "install" : "up-to-date", current, latest };
}

/** The global re-install command for the detected package manager. */
export function cliInstallCommand(pm: CliPackageManager, version: string): string {
  const ref = `openship@${version || "latest"}`;
  return pm === "bun" ? `bun add -g ${ref}` : `npm install -g ${ref}`;
}
