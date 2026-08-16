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
    localUrls: () => Promise<{ api: string; dashboard: string }>;
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

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
