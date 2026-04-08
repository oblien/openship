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