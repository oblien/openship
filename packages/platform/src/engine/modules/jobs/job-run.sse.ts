/**
 * Live channel for a custom job RUN — streams each output line + the terminal
 * outcome, keyed by job_run id. Built on the shared run-sse bus. The DB row is
 * the source of truth (final `output` is stored on finish); this only amplifies
 * a run in progress, so a client that connects late still gets a terminal
 * snapshot.
 */

import type { JobRun } from "@repo/db";
import { createRunBus } from "../../lib/run-bus";

export type JobRunEvent =
  | { type: "snapshot"; run: JobRun }
  | { type: "log"; line: string; level: "info" | "warn" | "error" }
  | { type: "complete"; status: "success" | "failed"; error?: string | null };

export const jobRunBus = createRunBus<JobRunEvent>((e) => e.type === "complete");
