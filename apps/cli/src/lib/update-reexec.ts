/**
 * Pure helpers for the `openship update` re-exec (see commands/update.ts).
 *
 * `openship update` fetches the new bundle, then re-execs the freshly-fetched
 * binary to run the service reconcile — the reconcile MUST run in the new code so
 * the NEW compose template / service unit is what lands. These two pieces (the
 * argv it re-execs with, and the loop guard) are pulled out here so they can be
 * unit-tested without importing the whole command (which pulls in compose/service
 * and their load-time IO).
 */
import { accessSync, closeSync, constants, openSync, readSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

/** The env sentinel a re-exec'd child carries, so it never re-execs again. */
export const REEXEC_ENV = "OPENSHIP_UPDATE_REEXEC";

/**
 * The version the FETCH phase just installed, carried to the re-exec'd child.
 *
 * The child is normally the freshly-fetched bundle (its own __CLI_VERSION__ is
 * the target), so pinning is a no-op there. But the child's identity is only
 * as good as the path resolution that spawned it — and several layouts keep a
 * RESOLVED-AT-INSTALL path alive (bun's isolated global store keeps the old
 * version's directory; a leftover tarball launcher earlier on PATH; argv[1]
 * resolved through a symlink captured before the swap). In those the child is
 * still the OLD bundle, and letting it pin its OWN version regenerates .env
 * with the PREVIOUS image tag — `openship update` installs the new CLI, then
 * pulls the old images right back (the "update always lands on the previous
 * version" report). The target travels out-of-band so the reconcile pins the
 * version that was actually installed, whichever bundle executes it.
 */
export const TARGET_VERSION_ENV = "OPENSHIP_UPDATE_TARGET_VERSION";

/** The fetch phase's installed version, when this process is a re-exec'd child. */
export function targetVersionEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const version = env[TARGET_VERSION_ENV]?.trim();
  return version || null;
}

/** True when THIS process is already a re-exec'd apply — must not spawn another. */
export function isReexecChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[REEXEC_ENV] === "1";
}

/**
 * The `openship` executable PATH resolves to, or null. Directories are scanned in
 * order so this matches what the operator's shell runs for a bare `openship` —
 * exactly the binary a package manager just swapped underneath the running
 * process. X_OK is probed rather than trusting existence: a stale non-executable
 * leftover must not hijack the re-exec.
 */
export function whichOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here (or not executable) — keep scanning.
    }
  }
  return null;
}

/**
 * The invocation for the phase-2 re-exec, given the process's own invocation
 * (`selfInvocation()` — passed in so this file stays free of service/compose
 * imports): prefer the `openship` bin on PATH over `process.argv[1]`.
 *
 * The bin on PATH is what the fetch phase's `bun|npm add -g` JUST repointed, and
 * what the operator's next bare `openship` will run — so it is the bundle the
 * reconcile should apply. argv[1] cannot be trusted to be that: under isolated
 * global layouts it stays pinned to the previous version's directory even after
 * the swap, and the child then reconciles with OLD code (old template, old image
 * pin). Equal to the fallback entry (npm/bun hoisted installs replace in place)
 * → nothing gained, keep the fallback untouched.
 */
export function freshInvocation(
  fallback: { runtime: string; args: string[] },
  env: NodeJS.ProcessEnv = process.env,
): { runtime: string; args: string[] } {
  if (process.platform === "win32") return fallback;
  // The LAUNCHER shape (tarball: no entry arg — the launcher takes the
  // subcommand directly) falls through unchanged: substituting its empty entry
  // with the PATH bin would hand the launcher that bin path as a bogus first
  // COMMAND ("…/openship update --apply-only" → unknown command). The launcher
  // re-resolves cli/current on every boot, so its child is already the fresh
  // bundle; only the pinned target matters there.
  if (fallback.args.length === 0) return fallback;
  const bin = whichOnPath("openship", env);
  if (!bin) return fallback;
  const entry = fallback.args[0] ? resolve(fallback.args[0]) : "";
  if (bin === entry) return fallback;
  // The repointed bin is normally a JS entry this process's runtime can run.
  // But an OLDER TARBALL LAUNCHER may still precede it on PATH — a /bin/sh
  // script — and executing that through Node is a SyntaxError, exit 1 (#13
  // review, reproduced). When the file's shebang names an interpreter that is
  // NOT node/bun, the file is not JS: execute it WHOLE through its shebang —
  // the OS resolves the interpreter, exactly like the operator's shell does,
  // and the launcher re-resolves node + cli/current itself. A node/bun
  // shebang (or no shebang) is a JS entry → keep running it under our runtime.
  const she = shebangInterpreter(bin);
  if (she !== null && !/(^|[\s/])(node|bun)(\s|$)/.test(she)) {
    return { runtime: bin, args: [] };
  }
  return { runtime: fallback.runtime, args: [bin] };
}

/**
 * The file's shebang line (without "#!"), or null — including when the file
 * has none or can't be read (unreadable is not evidence of an interpreter;
 * the caller then keeps its own runtime). Only the first line matters.
 */
function shebangInterpreter(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(128);
    const read = readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, read).toString("utf8").split("\n", 1)[0];
    if (!line.startsWith("#!")) return null;
    return line.slice(2).trim() || null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * argv for `update --apply-only`. `--json` is a ROOT option (read via the
 * program's preAction hook in index.ts), so it must precede the subcommand to be
 * parsed as one — `--json update`, never `update --json`.
 */
export function applyOnlyArgv(selfArgs: string[], json: boolean): string[] {
  return [...selfArgs, ...(json ? ["--json"] : []), "update", "--apply-only"];
}
