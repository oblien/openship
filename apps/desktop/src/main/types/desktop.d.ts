/**
 * Type declarations for the desktop bridge exposed by the preload script.
 */

export interface DesktopBridge {
  isDesktop: true;
  config: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<boolean>;
    getAll: () => Promise<Record<string, unknown>>;
  };
  app: {
    version: () => Promise<string>;
    platform: string;
    cloudUrls: () => Promise<{ api: string; dashboard: string }>;
  };
  navigate: (url: string) => Promise<void>;
  onboarding: {
    complete: (apiUrl: string, dashboardUrl: string) => Promise<boolean>;
    openExternal: (url: string) => Promise<void>;
    browseFile: () => Promise<string | null>;
  };
  system: {
    browseFolder: () => Promise<string | null>;
  };
  reset: () => Promise<boolean>;
}

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
