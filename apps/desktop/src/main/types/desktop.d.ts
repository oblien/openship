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
    cloudUrls: () => Promise<{ api: string; dashboard: string }>;
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
  reset: () => Promise<boolean>;
}

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
