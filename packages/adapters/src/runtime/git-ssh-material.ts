/**
 * @module git-ssh-material
 *
 * The ONE place that lays out the ephemeral SSH clone material (private key +
 * pinned known_hosts) for a build. Three sites need it — the docker
 * clone-on-server (writes over an SSH executor), the bare pipeline (writes via
 * the runtime's secret-file hook) and the orchestrator's api-host clone (writes
 * to a local temp dir) — and each has a different IO backend but the SAME
 * layout, permissions and cleanup contract. Only the IO differs, so only the IO
 * is injected.
 *
 * Permissions are the load-bearing part: the directory must be 0700 and the key
 * 0600 or ssh refuses the key outright, and the key bytes must never travel
 * through a shell command line (where they would land in build logs) — hence
 * `writeSecret` rather than an `exec`'d heredoc.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";

import { sq } from "./git-clone";

/** Minimal IO surface a host needs to host SSH clone material. */
export interface GitSshWriter {
  /** Create `dir` (recursive, 0700). Must tolerate an existing directory. */
  ensureDir(dir: string): Promise<void>;
  /** Write `content` to `path` at 0600, WITHOUT passing it through a shell. */
  writeSecret(path: string, content: string): Promise<void>;
  /** Remove `dir` recursively. Best-effort — never throws. */
  remove(dir: string): Promise<void>;
}

export interface GitSshMaterial {
  keyFile: string;
  knownHostsFile: string;
  /** Remove the whole directory. Idempotent, never throws. */
  cleanup: () => Promise<void>;
}

/**
 * Write the key + known_hosts into `dir` and return their paths plus a cleanup
 * hook. Callers MUST invoke `cleanup` in a `finally` so key material never
 * outlives the clone.
 */
export async function materializeGitSsh(
  writer: GitSshWriter,
  dir: string,
  gitSsh: { privateKey: string; knownHosts: string },
): Promise<GitSshMaterial> {
  const keyFile = `${dir}/id`;
  const knownHostsFile = `${dir}/known_hosts`;

  await writer.ensureDir(dir);
  try {
    await writer.writeSecret(keyFile, gitSsh.privateKey);
    await writer.writeSecret(knownHostsFile, gitSsh.knownHosts);
  } catch (err) {
    // A partial write must not leave key bytes behind on the host.
    await writer.remove(dir);
    throw err;
  }

  return {
    keyFile,
    knownHostsFile,
    cleanup: () => writer.remove(dir),
  };
}

/**
 * Writer for a host reached through a shell — the docker clone-on-server (SSH
 * executor) and the bare pipeline (runtime exec + secret-file hook). `exec` runs
 * the mode-setting commands; `writeSecret` must transfer the bytes out of band
 * so they never appear in a command line.
 */
export function shellGitSshWriter(io: {
  exec: (command: string) => Promise<unknown>;
  writeSecret: (path: string, content: string) => Promise<void>;
}): GitSshWriter {
  return {
    ensureDir: async (dir) => {
      await io.exec(`mkdir -p ${sq(dir)} && chmod 700 ${sq(dir)}`);
    },
    writeSecret: async (path, content) => {
      await io.writeSecret(path, content);
      await io.exec(`chmod 600 ${sq(path)}`);
    },
    remove: async (dir) => {
      await io.exec(`rm -rf ${sq(dir)}`).catch(() => {});
    },
  };
}

/** Writer for material staged on THIS machine (the orchestrator's api-host clone). */
export function localGitSshWriter(): GitSshWriter {
  return {
    ensureDir: (dir) => mkdir(dir, { recursive: true, mode: 0o700 }).then(() => {}),
    writeSecret: (path, content) => writeFile(path, content, { mode: 0o600 }),
    remove: (dir) => rm(dir, { recursive: true, force: true }).catch(() => {}),
  };
}
