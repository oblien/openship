import { exitCommand, rethrowCommandExit } from "./command-exit";
/**
 * Small per-command helpers shared across the cross-cutting commands.
 * `spin` suppresses the spinner in JSON mode so stdout stays a clean data
 * stream; `fail` renders an ApiError (or any error) and exits non-zero.
 */
import chalk from "chalk";
import ora, { type Ora } from "ora";
import { ApiError } from "./ship-client";
import { isJsonMode, err } from "./output";

export function spin(text: string): Ora | null {
  return isJsonMode() ? null : ora(text).start();
}

export function fail(e: unknown): never {
  rethrowCommandExit(e);
  if (e instanceof ApiError) {
    err(`  ${e.message}${e.status ? chalk.dim(` (${e.status})`) : ""}`);
  } else {
    err(`  ${e instanceof Error ? e.message : String(e)}`);
  }
  exitCommand(1);
}
