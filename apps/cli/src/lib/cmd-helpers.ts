import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { exitCommand, rethrowCommandExit } from "./command-exit";
/**
 * Small per-command helpers shared across the cross-cutting commands.
 * `spin` suppresses the spinner in JSON mode so stdout stays a clean data
 * stream; `fail` renders an ApiError (or any error) and exits non-zero.
 */
import chalk from "chalk";
import ora, { type Ora } from "ora";
import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";
import { ApiError } from "./ship-client";
import { ValidationError } from "@repo/sdk/client";
import type { AgentExecResult } from "@repo/contracts";
import { isJsonMode, err, info, ok, printJson } from "./output";

export function spin(text: string): Ora | null {
  return isJsonMode() ? null : ora(text).start();
}

export function fail(e: unknown): never {
  rethrowCommandExit(e);
  if (e instanceof ApiError) {
    err(`  ${e.message}${e.status ? chalk.dim(` (${e.status})`) : ""}`);
  } else {
    err(`  ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof ValidationError && e.details) {
      for (const messages of Object.values(e.details))
        for (const message of messages) err(`  ${message}`);
    }
  }
  exitCommand(1);
}

export function reportResult(result: unknown, message?: string): void {
  if (isJsonMode() || !message) printJson(result);
  else ok(message);
}

/** Run SDK work with the same structured output and exit behavior in every mode. */
export function printResult(work: () => Promise<unknown>): Promise<void>;
export function printResult<T>(work: () => Promise<T>, render: (value: T) => void): Promise<void>;
export async function printResult<T>(work: () => Promise<T>, render: (value: T) => void = printJson): Promise<void> {
  try { render(await work()); }
  catch (error) {
    observeCaughtError(error, "cli/lib/cmd-helpers");
 fail(error); }
}

/** Host and container execution have the same output and shell exit contract. */
export function reportExecResult(result: AgentExecResult): void {
  if (isJsonMode()) printJson(result);
  else {
    process.stdout.write(result.output);
    if (result.truncated) info("  Output truncated.");
    if (result.timedOut) err("  Command timed out.");
  }
  process.exitCode = result.timedOut ? 124 : result.exitCode >= 0 && result.exitCode <= 255 ? result.exitCode : 1;
}

export async function confirmOrExit(yes: boolean | undefined, question: string): Promise<void> {
  if (yes) return;
  if (isJsonMode() || !stdin.isTTY) {
    err("Refusing to proceed without confirmation. Re-run with --yes.");
    exitCommand(1);
  }
  const rl = createInterface({ input: stdin, output: stderr });
  let answer: string;
  try { answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase(); }
  finally { rl.close(); }
  if (answer !== "y" && answer !== "yes") {
    info("Aborted.");
    exitCommand(0);
  }
}
