"use client";
import { reportCaughtError } from "@repo/core/diagnostics";


import { useEffect, useState } from "react";

export type Platform = "mac-arm" | "mac-intel" | "windows" | "linux" | "unknown";

export interface PlatformInfo {
  platform: Platform;
  label: string;
  icon: "apple" | "windows" | "linux" | "download";
  fileName: string;
}

const DOWNLOAD_BASE = "https://github.com/oblien/openship/releases/latest/download";

const PLATFORM_MAP: Record<Platform, PlatformInfo> = {
  "mac-arm": {
    platform: "mac-arm",
    label: "Download for Mac",
    icon: "apple",
    fileName: "Openship-arm64.dmg",
  },
  "mac-intel": {
    platform: "mac-intel",
    label: "Download for Mac",
    icon: "apple",
    fileName: "Openship-x64.dmg",
  },
  windows: {
    platform: "windows",
    label: "Download for Windows",
    icon: "windows",
    fileName: "Openship-win32-x64.zip",
  },
  linux: {
    platform: "linux",
    label: "Download for Linux",
    icon: "linux",
    fileName: "Openship.AppImage",
  },
  unknown: {
    platform: "unknown",
    label: "Download",
    icon: "download",
    fileName: "",
  },
};

async function detectPlatform(): Promise<Platform> {
  if (typeof navigator === "undefined") return "unknown";

  const uaData = (navigator as { userAgentData?: any }).userAgentData;
  const ua = navigator.userAgent.toLowerCase();
  const platform = (uaData?.platform ?? navigator.platform ?? "").toLowerCase();

  if (platform.includes("mac") || ua.includes("macintosh")) {
    // macOS freezes its UA to "Intel Mac OS X" even on Apple Silicon, so the UA
    // string can NOT distinguish arm from intel (the old `!ua.includes("intel")`
    // heuristic mis-served x64 to every M-series Mac). Use Client Hints where
    // available (Chromium); otherwise default to Apple Silicon — every Mac since
    // 2020 is arm, so that's the safe fallback for Safari/Firefox.
    let arch = "";
    try {
      arch = (await uaData?.getHighEntropyValues?.(["architecture"]))?.architecture ?? "";
    } catch (error) {
      reportCaughtError(error, "web/hooks/use-platform");
      /* Client Hints unsupported → fall through to the Apple Silicon default */
    }
    return arch === "x86" ? "mac-intel" : "mac-arm";
  }

  if (platform.includes("win") || ua.includes("windows")) return "windows";
  if (platform.includes("linux") || ua.includes("linux")) return "linux";

  return "unknown";
}

export function usePlatform() {
  const [info, setInfo] = useState<PlatformInfo>(PLATFORM_MAP.unknown);

  useEffect(() => {
    let alive = true;
    void detectPlatform().then((detected) => {
      if (alive) setInfo(PLATFORM_MAP[detected]);
    });
    return () => {
      alive = false;
    };
  }, []);

  return {
    ...info,
    downloadUrl: info.fileName ? `${DOWNLOAD_BASE}/${info.fileName}` : "/download",
    allPlatforms: Object.values(PLATFORM_MAP).filter((p) => p.platform !== "unknown"),
    getDownloadUrl: (p: Platform) =>
      `${DOWNLOAD_BASE}/${PLATFORM_MAP[p].fileName}`,
  };
}
