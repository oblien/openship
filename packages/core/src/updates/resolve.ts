/**
 * Pure update-resolution logic shared by the desktop in-app updater
 * (apps/desktop/src/main/updater.ts) and the CLI `openship update` command.
 *
 * Kept here (no I/O, no Electron/Node-fs) so the exact asset-selection + version
 * gate is unit-testable with synthetic GitHub `releases/latest` payloads — the
 * single source of truth for "which installer asset does this platform pull".
 */

import { compareSemver } from "./semver";
import { findAnnouncement } from "./advisories";
import type { Advisory, AdvisoryManifest } from "./types";

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
  | {
      available: true;
      version: string;
      notes: string;
      asset: DesktopUpdateAsset;
      /**
       * The advisory that authorizes interrupting the user about this update, or
       * null for a routine release (installable from Settings → Updates, no
       * modal). Carries the title/message its author wrote, so a caller that
       * prompts can say WHY without inventing copy.
       */
      announcement: Advisory | null;
    }
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
 * Fold a `releases/latest` payload + the advisory manifest + platform/arch +
 * current version into the WHOLE update decision. Available only when the
 * release is strictly newer AND ships an asset for this platform. Never throws.
 *
 * Two questions, two sources, resolved once here:
 *   - "is there something newer to install?" → the release feed (version + asset)
 *   - "may I interrupt the user about it?"    → the advisory manifest, and only it
 * Callers act on `announcement`; nothing downstream re-fetches the manifest or
 * re-decides from severity.
 */
export function resolveDesktopUpdate(input: {
  releasePayload: GithubReleasePayload | null | undefined;
  platform: string;
  arch: string;
  currentVersion: string;
  /** Parsed advisory manifest for the release tag. Absent/null → never prompt. */
  manifest?: AdvisoryManifest | null;
}): DesktopUpdateCheck {
  const { releasePayload, platform, arch, currentVersion, manifest } = input;
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
    // Mode "desktop": a VPS-only advisory (edge/OpenResty, compose) must never
    // pop a modal in the desktop app, and vice versa.
    announcement: findAnnouncement(currentVersion, manifest, "desktop"),
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
