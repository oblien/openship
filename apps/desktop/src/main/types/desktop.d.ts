/**
 * Type declarations for the desktop bridge exposed by the preload script.
 */

// The key allowlist lives with the code that enforces it, so this can't drift.
import type { RendererConfigKey } from "../security";

export interface DesktopBridge {
  isDesktop: true;
  config: {
    get: (key: RendererConfigKey) => Promise<unknown>;
    set: (key: RendererConfigKey, value: unknown) => Promise<boolean>;
  };
  app: {
    version: () => Promise<string>;
    platform: string;
    localUrls: () => Promise<DesktopControlPlaneInfo>;
  };
  instance: {
    info: () => Promise<DesktopControlPlaneInfo>;
    openBrowser: () => Promise<boolean>;
    openDataFolder: () => Promise<boolean>;
    restartEngine: () => Promise<boolean>;
    repairEndpoint: () => Promise<boolean>;
    backup: () => Promise<string | null>;
    onChange: (cb: (info: DesktopControlPlaneInfo) => void) => () => void;
  };
  onboarding: {
    complete: (apiUrl: string, dashboardUrl: string) => Promise<boolean>;
    openExternal: (url: string) => Promise<void>;
    browseFile: () => Promise<string | null>;
  };
  system: {
    browseFolder: () => Promise<string | null>;
    browseFile: () => Promise<string | null>;
  };
  profiles: {
    list: () => Promise<DesktopProfilesState>;
    create: (name: string) => Promise<DesktopProfile>;
    rename: (id: string, name: string) => Promise<DesktopProfile>;
    switch: (id: string) => Promise<boolean>;
    remove: (id: string) => Promise<boolean>;
  };
  reset: () => Promise<boolean>;
}

export interface DesktopProfile {
  id: string;
  name: string;
  partition: string | null;
  createdAt: string;
  lastUsedAt: string;
}

export interface DesktopProfilesState {
  activeProfileId: string;
  profiles: DesktopProfile[];
}

export interface DesktopControlPlaneInfo {
  api: string;
  dashboard: string;
  advertisedOrigin: string;
  previousAdvertisedOrigin: string | null;
  switched: { api: boolean; dashboard: boolean };
  fingerprint: string;
  dataPath: string;
  userDataPath: string;
}

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
