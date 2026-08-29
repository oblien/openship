declare global {
  type DesktopConfigKey =
    | "autoUpdate"
    | "updateNotifications"
    | "dismissedAdvisoryIds"
    | "lastSeenVersion";

  type DesktopCloudAuthResult = {
    ok?: boolean;
    nonce?: string;
    error?: string;
  };

  type DesktopCloudPollResult = {
    status: "pending" | "resolved" | "expired" | "error";
  };

  interface DesktopBridge {
    isDesktop?: boolean;
    reset?: () => Promise<unknown>;
    app?: {
      version: () => Promise<string>;
      platform?: string;
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
    onboarding: {
      cloudAuth: () => Promise<DesktopCloudAuthResult>;
      cloudAuthPoll: (nonce: string) => Promise<DesktopCloudPollResult>;
    };
  }

  interface Window {
    desktop?: DesktopBridge;
  }
}

export {};