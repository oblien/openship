/**
 * The machine the CLI is running on, as the resolver measured it.
 *
 * `openship up` provisions the box it is invoked on, so "the target host" and "this
 * process's host" are the same thing — and before this the CLI answered questions about
 * it three different ways: a `command -v systemctl` of its own, a `command -v ufw` +
 * `ufw status` of its own, and a fabricated `{os:"linux",serviceManager:"systemd"}` cast.
 * Each was a separate opinion that could disagree with the other two and with the API.
 *
 * One line, so the import reads as what it is. Memoized inside
 * `resolveLocalEnvironmentSync`, so calling it per question costs nothing.
 */

import { envOps, resolveLocalEnvironmentSync, type EnvOps, type Op } from "@repo/adapters";

export function thisHost(): EnvOps {
  return envOps(resolveLocalEnvironmentSync());
}

/**
 * An `Op` as the operator would paste it, or null when there was nothing to offer.
 *
 * `sudo ` and ` && ` are added here because these strings are printed, not run: the ops
 * layer renders unprefixed steps precisely so the CLI's copy and the host's execution can
 * share one table. The prefix is dropped when we already measured this box as root — the
 * same rule `sudoPrefix()` applies before executing, so what we print and what we'd run
 * agree about privilege too. Null rather than a refusal string: these are hints alongside
 * a message that already says what happened, so a box with no service manager should
 * simply not be handed a command it can't run.
 */
export function pasteable(op: Op): string | null {
  if (!op.supported) return null;
  const sudo = thisHost().profile.isRoot ? "" : "sudo ";
  return op.value.map((step) => `${sudo}${step}`).join(" && ");
}

/** How an operator starts `unit` on this box, ready to paste. */
export function startUnitHint(unit: string): string | null {
  return pasteable(thisHost().serviceEnableStart(unit));
}
