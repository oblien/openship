/**
 * The deploy-time release phase — commands that run ONCE per deploy, after the
 * build and before the new version is activated.
 *
 * OFF IS THE DEFAULT: a project with no `releaseCommands` runs nothing here and
 * its deploy is byte-identical to what it was before this module existed. What
 * it buys the projects that do declare them is the thing an app stack could not
 * express at all until now — an app declares exactly one start command, so
 * `php artisan migrate --force`, `rails db:migrate` and `manage.py migrate`
 * never ran, and a stock Laravel app's schema had to be bootstrapped by hand
 * through the service terminal.
 *
 * Unlike the readiness gate, a failure here has no warn/fail choice: a release
 * command exists to be a precondition of serving the new version, so a non-zero
 * exit FAILS the deploy. That is the safe direction — the previous version is
 * still running and still routed at this point in the pipeline, so a failed
 * migration leaves the old app serving instead of cutting over to one that
 * cannot talk to its database.
 */

import { SYSTEM, safeErrorMessage } from "@repo/core";

/**
 * Normalize a project's / snapshot's declared commands into the list the phase
 * actually runs. Blank entries are dropped (a settings form's empty row), so
 * `["  "]` resolves to "nothing to run" rather than a shell no-op that still
 * costs a container.
 */
export function resolveReleaseCommands(declared: string[] | null | undefined): string[] {
  if (!Array.isArray(declared)) return [];
  return declared.map((command) => command.trim()).filter((command) => command.length > 0);
}

/**
 * Run the release phase.
 *
 * `run` is injected — it's `runtime.runReleaseCommand` bound to the deploy
 * config at the call site — so the ordering, the log markers, the fail-fast and
 * the unsupported-runtime skip are all testable without a runtime, a container
 * or a daemon.
 *
 * Returns nothing and throws on the first failure: the caller turns that into a
 * failed deployment. `run: undefined` means the runtime has no such primitive
 * (cloud) — the phase then logs a warning naming what it skipped and returns,
 * because refusing the deploy outright would break every existing cloud project
 * the moment someone added a release command for their self-hosted target.
 *
 * `deliberateSkipReason` is the other kind of skip: the commands COULD run here
 * and are deliberately not run (a rollback replaying an older release's
 * migrations). It logs at info rather than warn, because it is the correct
 * outcome rather than a degraded one.
 */
export async function runReleasePhase(opts: {
  commands: string[];
  /** Runs ONE command; rejects with the command's output on a non-zero exit. */
  run?: (command: string) => Promise<void>;
  /** Why `run` is missing — logged so a skipped migration is never silent. */
  unsupportedReason?: string;
  /**
   * Set when the phase is skipped BY DESIGN rather than for want of a runtime
   * primitive. Kept separate from `unsupportedReason` because the two need
   * opposite advice: an unsupported runtime tells the operator to run the
   * commands by hand, whereas a deliberate skip means they should NOT be run.
   */
  deliberateSkipReason?: string;
  log: (message: string, level?: "info" | "warn" | "error") => void;
}): Promise<void> {
  const { commands, run, unsupportedReason, deliberateSkipReason, log } = opts;
  if (commands.length === 0) return;

  // Ordered before the `run` check on purpose: a deliberate skip is a decision
  // about whether the commands SHOULD run, which outranks whether they could.
  if (deliberateSkipReason) {
    log(
      `${deliberateSkipReason} — not running ` +
        `${commands.length} release command${commands.length === 1 ? "" : "s"}: ` +
        `${commands.join(", ")}.`,
    );
    return;
  }

  if (!run) {
    log(
      `${unsupportedReason ?? "This runtime cannot run release commands"} — skipping ` +
        `${commands.length} release command${commands.length === 1 ? "" : "s"}: ` +
        `${commands.join(", ")}. Run them by hand before this version serves traffic.`,
      "warn",
    );
    return;
  }

  log(
    `Release phase: running ${commands.length} command${commands.length === 1 ? "" : "s"} ` +
      `before this version goes live (a failure here fails the deploy and leaves the ` +
      `previous version serving).`,
  );

  for (const [index, command] of commands.entries()) {
    const marker = `[release ${index + 1}/${commands.length}]`;
    log(`${marker} $ ${command}`);
    try {
      await run(command);
    } catch (err) {
      const message = safeErrorMessage(err);
      log(`${marker} failed: ${message}`, "error");
      throw new Error(`Release command failed: ${command}\n${message}`);
    }
    log(`${marker} done.`);
  }

  log("Release phase complete.");
}

/** Per-command budget. Re-exported so the pipeline and its tests name one number. */
export const RELEASE_COMMAND_TIMEOUT_MS = SYSTEM.DEPLOYMENTS.RELEASE_COMMAND_TIMEOUT_MS;
