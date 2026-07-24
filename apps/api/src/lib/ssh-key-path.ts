/**
 * Shared safety check for `server.sshKeyPath` values.
 *
 * The DB stores an absolute path on the API host. Operators normally
 * pick one of the standard locations under their home directory; an
 * attacker who can write to the servers row could otherwise point
 * sshKeyPath at /etc/shadow, /proc/self/environ, or any other file
 * the API process can read, and the resulting key bytes would land
 * in the SFTP private-key field for exfiltration on the next backup.
 *
 * The audit found the previous check (`!isAbsolute || includes("..")`)
 * was not enough — `/etc/shadow` is absolute and contains no `..`.
 *
 * Policy:
 *   - absolute path, no `..` segments, no null bytes
 *   - must sit under an allowed root (operator-controlled directories
 *     OR an env-configured override)
 *   - deny common system paths even when nested under an env-configured or
 *     caller-supplied root (the built-in DEFAULT_ROOTS are exempt — one of
 *     them, /etc/openship/ssh-keys, deliberately sits under /etc)
 *
 * Tests live in test/lib/ssh-key-path.test.ts.
 */

import { isAbsolute, resolve, sep } from "node:path";
import { env } from "../config/env";

/** Hard-coded denylist of system paths regardless of root config. */
const SYSTEM_DENY = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/var/lib/postgresql",
  "/var/lib/docker",
  "/root/.ssh",
];

/** Default roots — operator's home / standard SSH key dirs. The user
 *  field is intentionally empty: callers pass the operator's HOME via
 *  resolveSafeSshKeyPath's `extraRoots` argument. */
const DEFAULT_ROOTS = ["/var/lib/openship/ssh-keys", "/etc/openship/ssh-keys"];

export interface SshKeyPathOptions {
  /** Extra allowed roots — typically the operator's $HOME so they can
   *  point at ~/.ssh/foo without an explicit configuration step. */
  extraRoots?: string[];
}

/**
 * Returns the resolved absolute path on success or throws with a
 * specific reason on failure. Callers should let the error bubble —
 * the message is safe to surface to operators (no path-existence
 * disclosure beyond what they configured themselves).
 */
export function resolveSafeSshKeyPath(
  raw: string,
  opts: SshKeyPathOptions = {},
): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("sshKeyPath is empty");
  }
  if (trimmed.includes("\0")) {
    throw new Error("sshKeyPath contains a null byte");
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(`sshKeyPath must be absolute: ${trimmed}`);
  }
  if (trimmed.split("/").includes("..")) {
    throw new Error(`sshKeyPath contains traversal segment: ${trimmed}`);
  }

  const resolved = resolve(trimmed);

  // SYSTEM_DENY is deliberately broad (`/etc`), and one of the built-in
  // DEFAULT_ROOTS sits inside it (`/etc/openship/ssh-keys`). Those roots are
  // hardcoded here — not operator- or caller-supplied — so a path under one is
  // an explicit carve-out and skips the denylist. Env-configured and caller
  // supplied roots deliberately do NOT get this exemption, so an `extraRoots`
  // of `/` (or a `$HOME` of `/`) still can't unlock `/etc/shadow`.
  const underDefaultRoot = DEFAULT_ROOTS.map((r) => resolve(r)).some(
    (root) => resolved === root || resolved.startsWith(root + sep),
  );

  if (!underDefaultRoot) {
    for (const denied of SYSTEM_DENY) {
      if (resolved === denied || resolved.startsWith(denied + sep)) {
        throw new Error(
          `sshKeyPath is inside a protected system directory (${denied}): ${trimmed}`,
        );
      }
    }
  }

  const envRoots = (env.SSH_KEY_PATH_ROOTS ?? "")
    .split(":")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  const allowedRoots = [
    ...DEFAULT_ROOTS,
    ...envRoots,
    ...(opts.extraRoots ?? []),
  ].map((r) => resolve(r));

  const insideRoot = allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(root + sep),
  );
  if (!insideRoot) {
    throw new Error(
      `sshKeyPath must sit under one of: ${allowedRoots.join(", ")}`,
    );
  }

  return resolved;
}
