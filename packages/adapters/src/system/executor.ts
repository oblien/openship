import { existsSync, readFileSync } from "node:fs";

import type { CommandExecutor, SshConfig } from "../types";
import { LocalExecutor } from "./local-executor";
import { SshExecutor } from "./ssh-executor";
import { SystemSshExecutor } from "./system-ssh-executor";

export { wrapLocalBuildCommand } from "./local-shell";
export { LocalExecutor } from "./local-executor";
export { SshExecutor } from "./ssh-executor";
export { SystemSshExecutor } from "./system-ssh-executor";

/**
 * One shared local executor. LocalExecutor holds no instance state (no client, no
 * channel, `dispose()` is a no-op), and every instance reaches the same machine, so
 * separate objects were pure allocation — and worse, they defeated per-executor
 * memoization: caches keyed by "which box is this" (see `resolveOurEdgeContainer`)
 * missed on every call because each platform construction handed them a new object.
 */
const localExecutor = new LocalExecutor();

export function createExecutor(ssh?: SshConfig): CommandExecutor {
  if (ssh) {
    // "agent" auth routes through the OS `ssh` binary (see SystemSshExecutor);
    // password/key auth use the in-process ssh2 client.
    if (ssh.useSystemSsh) return new SystemSshExecutor(ssh);
    return new SshExecutor(ssh);
  }
  return localExecutor;
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
/** Host control explicitly switched off by the operator (`--no-host-control`). */
export function hostControlDisabled(): boolean {
  return process.env.OPENSHIP_HOST_CONTROL?.trim().toLowerCase() === "false";
}

/**
 * Are WE running inside a container?
 *
 * The distinction that matters for {@link createHostExecutor}: `LocalExecutor`
 * targets the host on a bare install and the CONTAINER's own namespace in a
 * containerized one. Those are completely different machines, and the difference is
 * invisible in the command output — `docker volume inspect` happily returns a host
 * path that does not exist where the command ran.
 *
 * `/.dockerenv` is Docker's own marker (the same probe domain.service.ts:368 uses);
 * the cgroup scan covers podman and Docker configurations that omit it. Sync reads
 * because callers are synchronous, and both are single small local files.
 */
function runningInContainer(): boolean {
  if (process.env.OPENSHIP_IN_CONTAINER?.trim().toLowerCase() === "true") return true;
  try {
    if (existsSync("/.dockerenv")) return true;
  } catch {
    /* fall through to the cgroup probe */
  }
  try {
    return /\b(docker|containerd|podman|kubepods)\b/.test(readFileSync("/proc/1/cgroup", "utf8"));
  } catch {
    // No procfs (macOS/Windows dev) — those are never the containerized API.
    return false;
  }
}

export function createHostExecutor(): CommandExecutor {
  // Explicit opt-out: FAIL rather than degrade. The `!host → LocalExecutor`
  // fallback below is correct for a bare install (LocalExecutor IS the host) but
  // would silently target the CONTAINER's own filesystem in a containerized one —
  // so a disabled host channel must throw, not quietly operate on the wrong box.
  if (hostControlDisabled()) {
    throw new Error(
      "Host control is disabled on this instance (OPENSHIP_HOST_CONTROL=false). " +
        "Re-run `openship up` without --no-host-control to allow host operations.",
    );
  }
  const host = process.env.OPENSHIP_HOST_SSH_HOST?.trim();
  if (!host) {
    // The hazard the comment above names, for the UNCONFIGURED case rather than the
    // disabled one — and it used to fall through here silently.
    //
    // Containerized with no host channel meant every "this machine" operation ran
    // INSIDE the api container: `docker …` → `docker: not found` (only the socket is
    // mounted, not the CLI), and any host path the daemon reports — a volume's
    // `/var/lib/docker/volumes/<v>/_data` — simply doesn't exist here, so rsync dies
    // with `mkdir … No such file or directory`. Both surface far from the cause,
    // during a migration's data move, looking like Docker or rsync bugs.
    //
    // Fail with the actual remedy instead. Do NOT "fix" this by adding a docker CLI
    // and bind-mounting the host's Docker data-root into the container: that makes
    // the container write daemon-private state directly (unsupported, breaks on
    // non-local volume drivers and rootless installs) to paper over a host channel
    // that simply wasn't provisioned.
    if (runningInContainer()) {
      throw new Error(
        "This operation targets the HOST machine, but no host channel is configured " +
          "(OPENSHIP_HOST_SSH_HOST is unset) and Openship is running in a container — " +
          "so it would have run inside the container instead, against the wrong " +
          "filesystem. Re-run `openship up` to provision the host channel.",
      );
    }
    return localExecutor;
  }
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
