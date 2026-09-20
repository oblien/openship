import type { ContextRole, ContextUser } from "./context";
import type { OperatorNoticeOperations } from "@repo/contracts";

export interface NativePlatformOptions {
  /** Stable identifier shared only by processes intentionally using the same installation. */
  instanceId: string;
  /** Private source, release and provider state. Never defaults to ~/.openship. */
  stateDirectory: string;
  storage:
    | { driver: "pglite"; dataDir: string; migrations?: "apply" | "verify" }
    | { driver: "postgres"; url: string; migrations?: "apply" | "verify" };
  /** Persistent UTF-8 secret, 32–4096 bytes. Uses Openship's existing SHA-256/AES-GCM format. */
  encryptionKey: string;
  runtime: "docker" | "bare" | "cloud";
  /** Bare runtimes may explicitly omit managed routing/TLS. */
  routing?: "managed" | "none";
  cloud?: { clientId: string; clientSecret: string; hosted?: boolean; redisUrl?: string };
  policy?: {
    /** Host builds, host administration, SSH agent/config and host key files require explicit opt-in. */
    allowHostExecution?: boolean;
    /** Bind loopback listeners that forward to explicitly authorized remote servers. */
    allowLocalForwarding?: boolean;
    /** Native directory inputs must be contained in one of these real filesystem roots. */
    sourceRoots?: readonly string[];
  };
  /** Enable the shared runner, backups/restores and saved maintenance schedules at start(). Defaults false. */
  jobs?: boolean;
  /** Exclusive recovery is only valid for the owned, file-backed PGlite process. */
  recovery?: "none" | "exclusive";
  /** Exposes installation management to trusted host code; never copied to a scoped view. */
  administration?: boolean;
  /** Route retained engine diagnostics without mixing them into a CLI's JSON stdout. */
  diagnostics?: "inherit" | "stderr" | "silent";
  /** Additional provider configuration. Storage, identity, mode and ownership fields are reserved. */
  environment?: Readonly<Record<string, string>>;
}

export interface ExternalIdentityInput {
  issuer: string;
  subject: string;
  email: string;
  name?: string;
  /** Explicit account linking; an email match alone never links accounts. */
  userId?: string;
  /** Installation authority is assigned only by the explicitly enabled host operator. */
  instanceAdmin?: boolean;
}

export interface ExternalIdentityResult {
  user: ContextUser;
  personalOrganizationId: string;
}

export interface NativeOperator {
  readonly notices: OperatorNoticeOperations;
  ensureIdentity(input: ExternalIdentityInput): Promise<ExternalIdentityResult>;
  resolveIdentity(input: { issuer: string; subject: string }): Promise<ExternalIdentityResult | null>;
  ensureNamespace(input: { issuer: string; key: string; name: string; ownerUserId: string }): Promise<{ organizationId: string }>;
  setMembership(input: { organizationId: string; userId: string; role: ContextRole | null }): Promise<void>;
}

export interface NativeCloseOptions {
  mode?: "drain";
  /** A deadline rejects the wait; owned work keeps draining and is never killed to meet it. */
  timeoutMs?: number;
}
