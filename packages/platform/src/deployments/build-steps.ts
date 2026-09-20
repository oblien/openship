import type { LogEntry } from "@repo/core";

// Single source of truth for build-step ordering + progress, shared by
// session-manager (live SSE progress) and build.service (getBuildSessionStatus).
// Both previously kept hand-synced copies. STEP_INDEX must also match the
// frontend STEPS array (which prepends a "prepare" step).

export const STEP_INDEX: Record<string, number> = {
  prepare: 0,
  clone: 1,
  install: 2,
  build: 3,
  deploy: 4,
};

export const STEP_PROGRESS: Record<string, number> = {
  prepare: 3,
  clone: 10,
  install: 30,
  build: 55,
  deploy: 80,
};

export function progressForStep(step: string, stepStatus?: LogEntry["stepStatus"]): number {
  const base = STEP_PROGRESS[step] ?? 0;
  return stepStatus === "completed" ? base + 10 : base;
}
