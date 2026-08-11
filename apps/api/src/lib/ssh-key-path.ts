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
 *   - the operator's own `~/.ssh` is exempt from the denylist too, so a
 *     root-run API (homedir() === /root) can still use ~/.ssh/openship even
 *     though /root/.ssh is on the denylist — see the note at the check.
 *
 * Tests live in test/lib/ssh-key-path.test.ts.
 */

import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { env } from "../config/env";

/**
 * Hard-coded denylist of system paths regardless of root config.
 *
 * Deliberately a STATIC SUPERSET of every host family, not derived from the resolved
 * host profile. A denylist that narrowed with detection would grant an attacker the
 * paths of whichever family we mis-detected — and this list guards the API's own
 * filesystem, which is one box, not the many targets the profile describes. So the
 * Debian data dir (`/var/lib/postgresql`) and the RHEL one (`/var/lib/pgsql`) are
 * both listed unconditionally.
 */
const SYSTEM_DENY = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/var/lib/postgresql",
  "/var/lib/pgsql",
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
  const isUnder = (root: string) =>
    resolved === root || resolved.startsWith(root + sep);

  // SYSTEM_DENY is deliberately broad (`/etc`, `/root/.ssh`). Two kinds of path
  // are exempt from it:
  //   1. the built-in DEFAULT_ROOTS — hardcoded, not caller-supplied, so one
  //      like `/etc/openship/ssh-keys` is an explicit carve-out.
  //   2. the operator's own `~/.ssh` — i.e. `<extraRoot>/.ssh`. extraRoots is
  //      always the home of the user the API runs as (never attacker input),
  //      and `~/.ssh` is where SSH keys naturally live. Without this a root-run
  //      API (homedir() === "/root") could never use `~/.ssh/openship`, because
  //      `/root/.ssh` is on the denylist — so the convenience buildSshConfig and
  //      hydrate-server advertise would silently fail only when running as root.
  // The carve-out is narrow (only `<home>/.ssh`), so an `extraRoots` of `/`
  // still can't unlock `/etc/shadow`. Tradeoff: on a root-run install this lets
  // a servers row read `/root/.ssh/id_rsa` — the same exposure a non-root
  // install already has for `/home/<op>/.ssh/*` (never on the denylist), so it
  // makes the policy consistent rather than adding a new class of exposure.
  const underDefaultRoot = DEFAULT_ROOTS.map((r) => resolve(r)).some(isUnder);
  const underOwnSshDir = (opts.extraRoots ?? [])
    .map((home) => resolve(home, ".ssh"))
    .some(isUnder);

  if (!underDefaultRoot && !underOwnSshDir) {
    for (const denied of SYSTEM_DENY) {
      if (isUnder(denied)) {
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

  if (!allowedRoots.some(isUnder)) {
    throw new Error(
      `sshKeyPath must sit under one of: ${allowedRoots.join(", ")}`,
    );
  }

  return resolved;
}

/**
 * The convenience root every runtime caller adds: the operator's home, so
 * `$HOME/.ssh/openship` works with no explicit configuration. Defined once so
 * `buildSshConfig` and the test-connection precheck can't disagree about which
 * paths are acceptable — a mismatch would mean "Test Connection" passing on a key
 * a real deploy then refuses (or vice versa).
 */
export function operatorSshKeyRoots(): string[] {
  return [homedir()];
}

/**
 * Why `raw` can't be used as a key path, or null when it can.
 *
 * `buildSshConfig` deliberately collapses every key-path failure into a null
 * return, which callers render as "Invalid auth configuration" — accurate but
 * useless when the real cause is a typo, a key the operator never copied to this
 * host, or a path outside the allowlist. Diagnostic surfaces (test-connection)
 * call this first so they can say which. Messages are operator-safe: they only
 * name the path the caller just supplied and the roots policy.
 */
export function sshKeyPathProblem(raw: string): string | null {
  let resolved: string;
  try {
    resolved = resolveSafeSshKeyPath(raw, { extraRoots: operatorSshKeyRoots() });
  } catch (err) {
    return err instanceof Error ? err.message : `sshKeyPath is not usable: ${raw}`;
  }

  try {
    accessSync(resolved, constants.R_OK);
  } catch {
    return `sshKeyPath is not readable by Openship — no such file, or no permission: ${resolved}`;
  }

  // A directory passes the readability probe but blows up in readFileSync later,
  // so name it here — picking `~/.ssh` instead of `~/.ssh/id_ed25519` is an easy
  // slip in a file dialog.
  if (!statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
    return `sshKeyPath is not a file: ${resolved}`;
  }

  return null;
}
