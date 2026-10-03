import type { CloudWorkspaceSummary } from "@repo/contracts";
import { repos } from "@repo/db";
import { env } from "../../config";
import { countryForIp } from "../../lib/geo-ip";

/** Public shape - what the controller returns to clients (no SSH secrets). */
export function serializeServer(s: Awaited<ReturnType<typeof repos.server.get>>, cloud: CloudWorkspaceSummary | null = null) {
  if (!s) return null;
  return {
    id: s.id,
    purpose: s.purpose,
    name: s.name,
    // The auto-registered host row (VPS / server-host mode). The dashboard
    // badges it "This Server" and hides SSH-credential fields for it.
    isLocal: s.isLocal,
    sshHost: s.sshHost,
    sshPort: s.sshPort,
    sshUser: s.sshUser,
    sshAuthMethod: s.sshAuthMethod,
    sshKeyPath: s.sshKeyPath,
    // Never return the key material itself — only whether one is stored, so the
    // edit form can offer "a key is stored; leave blank to keep it" (same idea as
    // the password field, which is simply absent from this shape).
    hasStoredKeyMaterial: !!s.sshPrivateKey,
    sshJumpHost: s.sshJumpHost,
    sshTransport: s.sshTransport ?? "direct",
    sshArgs: s.sshArgs,
    createdAt: s.createdAt,
    // ISO country for the row's flag; null for hostnames/private IPs or until
    // the geo DB is warmed (callers prime it via primeGeo before serializing).
    country: s.sshHost ? countryForIp(s.sshHost) : null,
    connection: s.workspaceId ? "cloud" as const : s.isLocal ? "local" as const : "ssh" as const,
    managed: cloud,
    terminalSessionLimit: cloud ? 1 : env.TERMINAL_MAX_SESSIONS_PER_USER,
    capabilities: {
      monitor: s.purpose !== "migration_source",
      terminal: s.purpose !== "migration_source",
      exec: s.purpose !== "migration_source",
      hostConfiguration: !s.workspaceId && s.purpose !== "migration_source",
      ssh: !s.workspaceId && !s.isLocal && s.purpose !== "migration_source",
      networkSettings: !!cloud,
    },
  };
}
