import { describe, expect, it } from "vitest";

import {
  desktopAssetName,
  resolveDesktopUpdate,
  resolveCliUpdatePlan,
  cliInstallCommand,
  type GithubReleasePayload,
} from "../src/updates/resolve";
import { parseManifest } from "../src/updates/advisories";

// A realistic `releases/latest` payload — asset names match .github/workflows/release.yml.
const RELEASE_0_2_0: GithubReleasePayload = {
  tag_name: "v0.2.0",
  body: "notes",
  assets: [
    { name: "Openship-arm64.dmg", browser_download_url: "https://x/arm64.dmg", size: 10 },
    { name: "Openship-x64.dmg", browser_download_url: "https://x/x64.dmg", size: 11 },
    { name: "Openship-win32-x64.zip", browser_download_url: "https://x/win.zip", size: 12 },
    { name: "Openship.AppImage", browser_download_url: "https://x/app.AppImage", size: 13 },
  ],
};

describe("desktopAssetName", () => {
  it("maps each platform/arch to the published asset (Windows = zip, NOT Setup.exe)", () => {
    expect(desktopAssetName("darwin", "arm64")).toBe("Openship-arm64.dmg");
    expect(desktopAssetName("darwin", "x64")).toBe("Openship-x64.dmg");
    expect(desktopAssetName("win32", "x64")).toBe("Openship-win32-x64.zip");
    expect(desktopAssetName("linux", "x64")).toBe("Openship.AppImage");
    expect(desktopAssetName("linux", "arm64")).toBe("Openship-arm64.AppImage");
    expect(desktopAssetName("aix", "x64")).toBeNull();
  });
});

describe("resolveDesktopUpdate", () => {
  it("Windows picks the .zip (regression guard for the Setup.exe mismatch)", () => {
    const r = resolveDesktopUpdate({
      releasePayload: RELEASE_0_2_0,
      platform: "win32",
      arch: "x64",
      currentVersion: "0.1.9",
    });
    expect(r.available).toBe(true);
    if (r.available) {
      expect(r.version).toBe("0.2.0");
      expect(r.asset.name).toBe("Openship-win32-x64.zip");
      expect(r.asset.url).toBe("https://x/win.zip");
    }
  });

  it("macOS picks the arch-specific dmg", () => {
    const arm = resolveDesktopUpdate({ releasePayload: RELEASE_0_2_0, platform: "darwin", arch: "arm64", currentVersion: "0.1.9" });
    const x64 = resolveDesktopUpdate({ releasePayload: RELEASE_0_2_0, platform: "darwin", arch: "x64", currentVersion: "0.1.9" });
    expect(arm.available && arm.asset.name).toBe("Openship-arm64.dmg");
    expect(x64.available && x64.asset.name).toBe("Openship-x64.dmg");
  });

  it("Linux picks the AppImage", () => {
    const r = resolveDesktopUpdate({ releasePayload: RELEASE_0_2_0, platform: "linux", arch: "x64", currentVersion: "0.1.9" });
    expect(r.available && r.asset.name).toBe("Openship.AppImage");
  });

  it("no update when current >= latest", () => {
    expect(resolveDesktopUpdate({ releasePayload: RELEASE_0_2_0, platform: "win32", arch: "x64", currentVersion: "0.2.0" }).available).toBe(false);
    expect(resolveDesktopUpdate({ releasePayload: RELEASE_0_2_0, platform: "win32", arch: "x64", currentVersion: "0.3.0" }).available).toBe(false);
  });

  it("no update when the platform asset is missing", () => {
    const onlyMac: GithubReleasePayload = { tag_name: "v0.2.0", assets: [{ name: "Openship-arm64.dmg", browser_download_url: "u", size: 1 }] };
    expect(resolveDesktopUpdate({ releasePayload: onlyMac, platform: "win32", arch: "x64", currentVersion: "0.1.9" }).available).toBe(false);
  });

  it("no update on an empty/absent payload", () => {
    expect(resolveDesktopUpdate({ releasePayload: null, platform: "darwin", arch: "arm64", currentVersion: "0.1.9" }).available).toBe(false);
    expect(resolveDesktopUpdate({ releasePayload: {}, platform: "darwin", arch: "arm64", currentVersion: "0.1.9" }).available).toBe(false);
  });
});

// The prompt gate: only the advisory manifest decides whether an available
// update may interrupt the user, and it says so with the `announce` key.
describe("resolveDesktopUpdate → announcement", () => {
  const check = (manifest: unknown, currentVersion = "0.1.9") =>
    resolveDesktopUpdate({
      releasePayload: RELEASE_0_2_0,
      platform: "darwin",
      arch: "arm64",
      currentVersion,
      manifest: manifest === undefined ? undefined : parseManifest(manifest),
    });

  const entry = (over: Record<string, unknown> = {}) => ({
    advisories: [
      {
        id: "update-0.2.0",
        severity: "recommended",
        announce: true,
        affects: "<0.2.0",
        title: "t",
        message: "m",
        ...over,
      },
    ],
  });

  it("no manifest → update available, but never a prompt", () => {
    const r = check(undefined);
    expect(r.available).toBe(true);
    expect(r.available && r.announcement).toBeNull();
  });

  it("announce: true + matching affects → prompt, carrying the advisory copy", () => {
    const r = check(entry());
    expect(r.available && r.announcement?.id).toBe("update-0.2.0");
    expect(r.available && r.announcement?.title).toBe("t");
  });

  it("announce: false is honoured even for a critical advisory", () => {
    const r = check(entry({ severity: "critical", announce: false }));
    expect(r.available && r.announcement).toBeNull();
  });

  it("omitted announce defaults per severity (legacy manifests)", () => {
    const legacyRecommended = check(entry({ announce: undefined }));
    const legacyInfo = check(entry({ severity: "info", announce: undefined }));
    expect(legacyRecommended.available && legacyRecommended.announcement?.id).toBe("update-0.2.0");
    expect(legacyInfo.available && legacyInfo.announcement).toBeNull();
  });

  it("affects that misses the running version → no prompt", () => {
    const r = check(entry({ affects: "<0.1.5" }));
    expect(r.available).toBe(true);
    expect(r.available && r.announcement).toBeNull();
  });

  it("a selfhosted-only advisory never prompts the desktop app", () => {
    const r = check(entry({ modes: ["selfhosted"] }));
    expect(r.available && r.announcement).toBeNull();
    const both = check(entry({ modes: ["selfhosted", "desktop"] }));
    expect(both.available && both.announcement?.id).toBe("update-0.2.0");
  });

  it("garbage manifest → no prompt (fails closed)", () => {
    expect(check({ advisories: "nope" }).available && check({ advisories: "nope" }).announcement).toBeNull();
    expect(check(null).available && check(null).announcement).toBeNull();
  });
});

describe("resolveCliUpdatePlan + cliInstallCommand", () => {
  it("installs when latest is newer, else up-to-date", () => {
    expect(resolveCliUpdatePlan("0.1.9", "0.2.0").action).toBe("install");
    expect(resolveCliUpdatePlan("0.2.0", "0.2.0").action).toBe("up-to-date");
    expect(resolveCliUpdatePlan("0.3.0", "0.2.0").action).toBe("up-to-date");
    expect(resolveCliUpdatePlan("0.1.9", "").action).toBe("up-to-date");
  });

  it("builds the right global install command per package manager", () => {
    expect(cliInstallCommand("bun", "0.2.0")).toBe("bun add -g openship@0.2.0");
    expect(cliInstallCommand("npm", "0.2.0")).toBe("npm install -g openship@0.2.0");
    expect(cliInstallCommand("bun", "")).toBe("bun add -g openship@latest");
  });
});
