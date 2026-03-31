// ─── System / SSH settings ───────────────────────────────────────────────────

export interface SystemSettings {
  serverName?: string;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthMethod?: string;
  sshPassword?: string;
  sshKeyPath?: string;
  sshKeyPassphrase?: string;
  sshJumpHost?: string;
  sshArgs?: string;
}

export interface TunnelConfig {
  provider: "edge" | "cloudflare" | "ngrok";
  token?: string;
}

// ─── SSH payload (collected from user input, before normalisation) ────────────

export interface SshPayload {
  host: string;
  user: string;
  method: "password" | "key";
  serverName?: string;
  password?: string;
  keyPath?: string;
  passphrase?: string;
  port?: number;
  jumpHost?: string;
  sshArgs?: string;
}

// ─── Build mode ──────────────────────────────────────────────────────────────

export type BuildMode = "auto" | "server" | "local";

// ─── Onboarding path & hosting mode ─────────────────────────────────────────

export type OnboardingPath = "cloud" | "selfhost";
export type HostingMode = "remote" | "local";

// ─── Step identifiers ────────────────────────────────────────────────────────

export type OnboardingStep =
  | "choose"
  | "selfhost-choice"
  | "ssh"
  | "tunnel"
  | "preferences"
  | "loading";

// ─── Collected onboarding state ──────────────────────────────────────────────

export interface OnboardingState {
  path?: OnboardingPath;
  hostingMode?: HostingMode;
  ssh?: SshPayload;
  tunnel?: TunnelConfig;
  buildMode: BuildMode;
  apiUrl: string;
  dashboardUrl: string;
}

// ─── Setup API payload (sent to /api/system/setup) ───────────────────────────

export interface SetupPayload {
  defaultBuildMode: string;
  authMode: string;
  serverName?: string | null;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthMethod?: string;
  sshPassword?: string;
  sshKeyPath?: string;
  sshKeyPassphrase?: string;
  sshJumpHost?: string;
  sshArgs?: string;
  tunnelProvider?: string;
  tunnelToken?: string;
}

// ─── Platform adapter (implemented per host: Electron, CLI, etc.) ────────────

export interface OnboardingPlatform {
  /** Open a URL in the system default browser */
  openExternal(url: string): void | Promise<void>;
  /** Browse for a file (SSH key). Returns the path or null if cancelled */
  browseFile?(): Promise<string | null>;
  /** Fetch wrapper — defaults to globalThis.fetch if not supplied */
  fetch?: typeof globalThis.fetch;
}
