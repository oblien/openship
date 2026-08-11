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

/** The env sentinel a re-exec'd child carries, so it never re-execs again. */
export const REEXEC_ENV = "OPENSHIP_UPDATE_REEXEC";

/** True when THIS process is already a re-exec'd apply — must not spawn another. */
export function isReexecChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[REEXEC_ENV] === "1";
}

/**
 * argv for `update --apply-only`. `--json` is a ROOT option (read via the
 * program's preAction hook in index.ts), so it must precede the subcommand to be
 * parsed as one — `--json update`, never `update --json`.
 */
export function applyOnlyArgv(selfArgs: string[], json: boolean): string[] {
  return [...selfArgs, ...(json ? ["--json"] : []), "update", "--apply-only"];
}
