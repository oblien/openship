declare global {
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
    config?: {
      get: <T = unknown>(key: string) => Promise<T>;
      set: (key: string, value: unknown) => Promise<unknown>;
      getAll: () => Promise<Record<string, unknown>>;
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