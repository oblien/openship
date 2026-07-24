import { readFileSync } from "node:fs";

import type { CommandExecutor, SshConfig } from "../types";
import { LocalExecutor } from "./local-executor";
import { SshExecutor } from "./ssh-executor";
import { SystemSshExecutor } from "./system-ssh-executor";

export { wrapLocalBuildCommand } from "./local-shell";
export { LocalExecutor } from "./local-executor";
export { SshExecutor } from "./ssh-executor";
export { SystemSshExecutor } from "./system-ssh-executor";

export function createExecutor(ssh?: SshConfig): CommandExecutor {
  if (ssh) {
    // "agent" auth routes through the OS `ssh` binary (see SystemSshExecutor);
    // password/key auth use the in-process ssh2 client.
    if (ssh.useSystemSsh) return new SystemSshExecutor(ssh);
    return new SshExecutor(ssh);
  }
  return new LocalExecutor();
}

/**
 * Executor for HOST-OS operations ("this machine") that works whether openship
 * runs bare OR in a container.
 *
 * Bare: `LocalExecutor` — commands run on the host directly.
 *
 * Containerized: a container can't apt/systemctl/edit files on its HOST, so when
 * `OPENSHIP_HOST_SSH_HOST` is set (the `openship up` CLI provisions this + a key
 * + the compose `extra_hosts: host.docker.internal:host-gateway`) we reach the
 * host over SSH via `host.docker.internal` — the docker-bridge gateway, an
 * INTERNAL address, never the public IP. Reuses the standard remote-server
 * pipeline (`SshExecutor`), so foreign-proxy handover / host system config land
 * on the host. Not more privilege than the mounted docker socket already grants.
 */
export function createHostExecutor(): CommandExecutor {
  const host = process.env.OPENSHIP_HOST_SSH_HOST?.trim();
  if (!host) return new LocalExecutor();
  const keyPath = process.env.OPENSHIP_HOST_SSH_KEY?.trim();
  const portRaw = Number(process.env.OPENSHIP_HOST_SSH_PORT || "22");
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 22;
  let privateKey: string | undefined;
  if (keyPath) {
    try {
      privateKey = readFileSync(keyPath, "utf8");
    } catch (err) {
      throw new Error(
        `Cannot read host SSH key at OPENSHIP_HOST_SSH_KEY=${keyPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return new SshExecutor({
    host,
    port,
    username: process.env.OPENSHIP_HOST_SSH_USER?.trim() || "root",
    privateKey,
  });
}
