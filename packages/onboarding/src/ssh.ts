import type { SshPayload, SystemSettings } from "./types";

/**
 * Convert a raw SshPayload (from user input) into the normalised
 * SystemSettings shape expected by the API.
 */
export function buildSshSettings(payload: SshPayload): SystemSettings {
  const settings: SystemSettings = {
    serverName: payload.serverName ?? undefined,
    sshHost: payload.host,
    sshPort: payload.port ?? 22,
    sshUser: payload.user || "root",
    sshAuthMethod: payload.method,
  };
  if (payload.password) settings.sshPassword = payload.password;
  if (payload.keyPath) settings.sshKeyPath = payload.keyPath;
  if (payload.passphrase) settings.sshKeyPassphrase = payload.passphrase;
  if (payload.jumpHost) settings.sshJumpHost = payload.jumpHost;
  if (payload.sshArgs) settings.sshArgs = payload.sshArgs;
  return settings;
}
