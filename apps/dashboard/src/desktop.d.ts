declare global {
  type DesktopConfigKey =
    | "autoUpdate"
    | "updateNotifications"
    | "dismissedAdvisoryIds"
    | "lastSeenVersion";

  type DesktopProfile = {
    id: string;
    name: string;
    createdAt: string;
    lastUsedAt: string;
  };

  type DesktopProfilesState = {
    activeProfileId: string;
    profiles: DesktopProfile[];
  };

  type DesktopControlPlaneInfo = {
    api: string;
    dashboard: string;
    advertisedOrigin: string;
    previousAdvertisedOrigin: string | null;
    switched: { api: boolean; dashboard: boolean };
    fingerprint: string;
    dataPath: string;
    userDataPath: string;
  };

  interface DesktopBridge {
    isDesktop?: boolean;
    reset?: () => Promise<unknown>;
    app?: {
      version: () => Promise<string>;
      platform?: string;
      localUrls?: () => Promise<DesktopControlPlaneInfo>;
    };
    instance?: {
      info: () => Promise<DesktopControlPlaneInfo>;
      openBrowser: () => Promise<boolean>;
      openDataFolder: () => Promise<boolean>;
      restartEngine: () => Promise<boolean>;
      repairEndpoint: () => Promise<boolean>;
      backup: () => Promise<string | null>;
      onChange: (cb: (info: DesktopControlPlaneInfo) => void) => () => void;
    };
    /** Update preferences only. The desktop config store also holds SSH
     *  credentials and tunnel tokens, which the bridge refuses to serve —
     *  see RENDERER_CONFIG_KEYS in apps/desktop/src/main/security.ts. */
    config?: {
      get: <T = unknown>(key: DesktopConfigKey) => Promise<T>;
      set: (key: DesktopConfigKey, value: unknown) => Promise<unknown>;
    };
    updates?: {
      check: () => Promise<{ available: boolean; version?: string }>;
      start: () => Promise<boolean>;
      open: () => Promise<boolean>;
      dismiss: () => Promise<boolean>;
      onProgress: (cb: (fraction: number) => void) => () => void;
      onDone: (cb: () => void) => () => void;
      onError: (cb: (message: string) => void) => () => void;
    };
    profiles?: {
      list: () => Promise<DesktopProfilesState>;
      create: (name: string) => Promise<DesktopProfile>;
      rename: (id: string, name: string) => Promise<DesktopProfile>;
      switch: (id: string) => Promise<boolean>;
      remove: (id: string) => Promise<boolean>;
    };
  }

  interface Window {
    desktop?: DesktopBridge;
  }
}

export {};
