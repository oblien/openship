"use client";

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
    fileName: "Openship-Setup.exe",
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

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "unknown";

  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator as any).userAgentData?.platform?.toLowerCase() ?? navigator.platform?.toLowerCase() ?? "";

  if (platform.includes("mac") || ua.includes("macintosh")) {
    // Check for Apple Silicon
    // Safari on Apple Silicon reports correctly, Chrome can use userAgentData
    const isArm =
      (navigator as any).userAgentData?.architecture === "arm" ||
      // Heuristic: post-2020 Macs running modern browsers
      (ua.includes("macintosh") && !ua.includes("intel"));
    return isArm ? "mac-arm" : "mac-intel";
  }

  if (platform.includes("win") || ua.includes("windows")) return "windows";
  if (platform.includes("linux") || ua.includes("linux")) return "linux";

  return "unknown";
}

export function usePlatform() {
  const [info, setInfo] = useState<PlatformInfo>(PLATFORM_MAP.unknown);

  useEffect(() => {
    const detected = detectPlatform();
    setInfo(PLATFORM_MAP[detected]);
  }, []);

  return {
    ...info,
    downloadUrl: info.fileName ? `${DOWNLOAD_BASE}/${info.fileName}` : "/download",
    allPlatforms: Object.values(PLATFORM_MAP).filter((p) => p.platform !== "unknown"),
    getDownloadUrl: (p: Platform) =>
      `${DOWNLOAD_BASE}/${PLATFORM_MAP[p].fileName}`,
  };
}
