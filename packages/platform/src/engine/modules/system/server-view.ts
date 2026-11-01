import type { CloudWorkspaceSummary, ServerGpu } from "@repo/contracts";
import { effectiveGpu, type HostCapacity } from "@repo/core";
import { repos } from "@repo/db";
import { env } from "../../config";
import { countryForIp } from "../../lib/geo-ip";

/**
 * GPU annotation for a server row. `capacity` is the daemon probe (`null` when it could not be read),
 * the row's `gpuOverride` is the manual mark. Pure, so the "manual wins in both directions" rule is
 * testable without a daemon.
 */
export function serverGpu(
  override: "yes" | "no" | null | undefined,
  capacity: HostCapacity | null,
): ServerGpu {
  const probed = !!capacity && capacity.source !== "unknown";
  const eff = effectiveGpu(probed ? capacity : null, override ?? null);
  const seen = probed ? effectiveGpu(capacity, null) : null;
  const detected = seen?.hasGpu ?? false;
  return {
    available: eff.hasGpu,
    detected,
    // The probed card count is a fact about the machine; a manual "no" hides the card from
    // scheduling but must not erase how many the daemon reported.
    count: eff.count ?? seen?.count ?? null,
    override: override ?? null,
    probed,
  };
}

/** Public shape - what the controller returns to clients (no SSH secrets). */
export function serializeServer(
  s: Awaited<ReturnType<typeof repos.server.get>>,
  cloud: CloudWorkspaceSummary | null = null,
  capacity: HostCapacity | null = null,
) {
  if (!s) return null;
  return {
    id: s.id,
    source: "local" as const,
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
    createdAt: s.createdAt.toISOString(),
    // ISO country for the row's flag; null for hostnames/private IPs or until
    // the geo DB is warmed (callers prime it via primeGeo before serializing).
    country: s.sshHost ? countryForIp(s.sshHost) : null,
    connection: s.workspaceId ? "cloud" as const : s.isLocal ? "local" as const : "ssh" as const,
    managed: cloud,
    // Managed (cloud) servers have no GPU model; everything else gets the annotation.
    ...(cloud || s.workspaceId ? {} : { gpu: serverGpu(s.gpuOverride, capacity) }),
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
