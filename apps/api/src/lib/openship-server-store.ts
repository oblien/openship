/**
 * The single owner of the `/root/.openship/` folder on a target server.
 *
 * Everything Openship persists ON a server (mail state, the project manifest)
 * lives in this one root-only directory so it's the server's self-describing
 * source of truth — survive-the-orchestrator state for disaster recovery.
 *
 * This module owns ONLY the storage mechanics: ensuring the folder exists and
 * atomic file read/write/remove over an SSH `CommandExecutor`. Domain modules
 * (`mail-state.ts`, `openship-manifest.ts`) layer their schemas on top and must
 * NOT re-implement the folder/mkdir/atomic-write logic — call these helpers.
 */

import {
  HOST_STATE_DIR,
  privilegedExecutor,
  type CommandExecutor,
  type Privileged,
} from "@repo/adapters";

/**
 * The one folder — now spelled once, in the resolver's ops layer.
 *
 * Kept as a named re-export because every consumer here composes paths *under* it
 * (`MANIFEST_PATH`, `STATE_FILE_PATH`) at module scope, where there is no target host
 * to ask. The constant is right for that: these files are root-owned by contract on
 * every managed Linux host, which is exactly the case `stateDir()` returns unchanged.
 */
export const OPENSHIP_DIR = HOST_STATE_DIR;

/**
 * Single-quote wrap for safe interpolation into a remote LOGIN SHELL. The file
 * `name` reaches these helpers from semi-trusted sources — e.g. a `snapshot-<id>`
 * name where `<id>` is a container label read during a migration scan — so every
 * interpolated path MUST be quoted or a crafted name (`x$(cmd)`, `x;cmd`) is root
 * RCE on the target. `writeFile` uses SFTP (no shell) and needs no quoting.
 */
function sq(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/**
 * The executor these helpers actually run through.
 *
 * The directory is 0700 root-owned by design, so on a host we log in to as a non-root
 * user EVERY operation here needs elevation — not just the writes. It used to need none
 * because the login was assumed to be root: `mkdir -p /root/.openship` is the first
 * thing such a server hits, and a `cat` of a file it could never have written returns
 * "" — indistinguishable from "this server has no Openship state", which is what `scan`
 * reads to re-import our own projects.
 *
 * The PATH does not move for a non-root login, unlike the remote journal's: elevation is
 * available here (`elevatedExecutor`'s `writeFile` stages through `/tmp` then sudo-mv's,
 * so the atomic write survives it), and this state is read back later — sometimes by a
 * different login user — so a host provisioned before this fix must still be found.
 */
async function storeExecutor(exec: CommandExecutor, purpose: string): Promise<Privileged> {
  const grant = await privilegedExecutor(exec, purpose, { onRefusedHost: "proceed" });
  if (!grant.supported) throw new Error(grant.reason);
  return grant.value;
}

/**
 * The one host shape where a read here CANNOT be attempted, recognized in TypeScript
 * because the shell cannot see it.
 *
 * A login that is neither root nor sudo-capable, against a 0700 root-owned directory.
 * From inside the remote shell that is invisible: the login user cannot traverse /root,
 * so `cat` fails with EACCES, `test -e` on the path answers "no", and `test -d` on the
 * dir answers "no" too. Absent and forbidden are the SAME observation down there, and
 * the reads below then reported exit 0 with empty stdout — so `unreadable` never fired
 * and the one distinction this module exists to keep vanished into a successful-looking
 * empty answer. The fact is known up here, before the command is sent.
 *
 * Narrow on purpose. A *supported* host with no route to root never reaches here at all —
 * `privilegedExecutor` refuses it and `storeExecutor` throws. `elevation: "none"` is
 * reachable only on a REFUSED host (privilege.ts:147), and that covers two opposite boxes.
 */
function cannotAttemptRead(p: Privileged): Error | null {
  // Unmeasurable — a banner, a forced command, a probe that never came back. `isRoot` and
  // `canSudo` are then absences rather than facts: the login may well BE root, and every
  // release before the resolver existed simply tried. Refusing on this arm would turn a
  // readable manifest into a missing one on any chatty box, which is the regression
  // `onRefusedHost: "proceed"` is documented to prevent — and `scan` reads a missing
  // manifest as "this server has no Openship projects".
  if (p.profile.probeError || p.profile.forcedCommand) return null;

  // Measured, and measured as having no route to root: an unsupported distro or arch whose
  // login is unprivileged. Here the two flags above ARE facts, and the read cannot work.
  return p.elevation === "none"
    ? new Error(
        `no route to root on this host (login is ${p.profile.loginUser}, passwordless sudo unavailable) and ${OPENSHIP_DIR} is root-only`,
      )
    : null;
}

/** The dir, created through an executor a caller has already gated. */
async function mkdirOpenship(e: CommandExecutor): Promise<void> {
  await e.exec(`mkdir -p ${sq(OPENSHIP_DIR)} && chmod 0700 ${sq(OPENSHIP_DIR)}`);
}

/**
 * A read that cannot be performed, answered with the caller's "not there" value.
 *
 * The non-throwing contract is deliberate (see `readOpenshipFile`) and callers
 * depend on it — but a REFUSED read and an ABSENT file must not be silently the
 * same event. The value has to stay ambiguous; the log must not. Without this,
 * a host that merely denies elevation reads as a host with no Openship state,
 * which is the exact confusion this module's header says it exists to end.
 */
function unreadable<T>(name: string, err: unknown, fallback: T): T {
  const reason = err instanceof Error ? err.message : String(err);
  console.warn(
    `[openship-server-store] cannot read ${OPENSHIP_DIR}/${name} — reporting it as absent: ${reason}`,
  );
  return fallback;
}

/**
 * Ensure the `.openship` dir exists, root-only (0700). Idempotent. THE single
 * place the folder is created — callers never `mkdir` it themselves.
 */
export async function ensureOpenshipDir(exec: CommandExecutor): Promise<void> {
  await mkdirOpenship((await storeExecutor(exec, "Writing Openship server state")).executor);
}

/**
 * Read a file from `.openship` by bare name (e.g. "mail-state.json"). Returns
 * "" when absent — never throws on a missing file.
 *
 * Also "" when the read could not be ATTEMPTED (elevation refused, transport
 * down). That is a compromise, not an equivalence: refusing here would turn a
 * readable manifest into a missing one on any host we can't measure, which is a
 * regression dressed as a safety check. The distinction is kept in the log —
 * see `unreadable`.
 */
export async function readOpenshipFile(exec: CommandExecutor, name: string): Promise<string> {
  const path = `${OPENSHIP_DIR}/${name}`;
  try {
    const p = await storeExecutor(exec, "Reading Openship server state");
    const blocked = cannotAttemptRead(p);
    if (blocked) return unreadable(name, blocked, "");
    return (await p.executor.exec(`cat ${sq(path)} 2>/dev/null || echo ""`)).trim();
  } catch (err) {
    return unreadable(name, err, "");
  }
}

/**
 * Atomically write a file into `.openship` (temp file → `mv -f`), root-only
 * (0600). Ensures the dir first. A kill mid-write never leaves a partial file.
 */
export async function writeOpenshipFile(
  exec: CommandExecutor,
  name: string,
  content: string,
): Promise<void> {
  const path = `${OPENSHIP_DIR}/${name}`;
  const tmp = `${path}.tmp`;
  // One grant for all three steps: the staged write must land under the dir this same
  // grant just created, and re-gating per step would re-probe for nothing.
  // No `cannotAttemptRead` gate here on purpose: a write that cannot be elevated must
  // FAIL, and it does — `mkdir -p /root/.openship` throws on its own. Only the reads
  // have a non-throwing contract to protect, and only they can be fooled by it.
  const { executor: e } = await storeExecutor(exec, "Writing Openship server state");
  await mkdirOpenship(e);
  await e.writeFile(tmp, content);
  await e.exec(`mv -f ${sq(tmp)} ${sq(path)} && chmod 0600 ${sq(path)}`);
}

/** Remove a file (and any stale temp) from `.openship`. Idempotent. */
export async function removeOpenshipFile(exec: CommandExecutor, name: string): Promise<void> {
  const path = `${OPENSHIP_DIR}/${name}`;
  const { executor: e } = await storeExecutor(exec, "Removing Openship server state");
  await e.exec(`rm -f ${sq(path)} ${sq(`${path}.tmp`)}`);
}

/** Existence check — `true` iff `.openship/<name>` is a file. One `test -f`
 *  rather than a read, but it still costs the same privilege grant as one
 *  (0700 root-owned), so it is not free on a non-root login. Same
 *  refused-reads-as-absent compromise as `readOpenshipFile`. */
export async function openshipFileExists(exec: CommandExecutor, name: string): Promise<boolean> {
  const path = `${OPENSHIP_DIR}/${name}`;
  try {
    const p = await storeExecutor(exec, "Reading Openship server state");
    const blocked = cannotAttemptRead(p);
    if (blocked) return unreadable(name, blocked, false);
    return (await p.executor.exec(`test -f ${sq(path)} && echo yes || echo no`)).trim() === "yes";
  } catch (err) {
    return unreadable(name, err, false);
  }
}
