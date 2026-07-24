/**
 * JobRunner factory + module singleton.
 *
 * Auto-selects the backend by probing REDIS_URL. Redis reachable in
 * ~2s → BullMQJobRunner; otherwise InProcessJobRunner. Decision is
 * made ONCE at first access; subsequent calls return the same
 * instance. Override via `OPENSHIP_JOB_RUNNER` env var when needed
 * (e.g. force in-process in tests even if Redis is available).
 *
 * Callers should never construct a runner directly — always go through
 * `getJobRunner()`.
 */

import { REDIS_REQUIRED } from "../../config/env";
import { isRedisReachable } from "../../lib/redis";
import { BullMQJobRunner } from "./bullmq";
import { InProcessJobRunner } from "./in-process";
import type { JobRunner } from "./types";

export type { JobRunner } from "./types";

let instance: JobRunner | null = null;
let resolvingPromise: Promise<JobRunner> | null = null;

/**
 * Probe Redis without throwing. Returns true if a ping succeeds within
 * `timeoutMs`. Uses a transient connection so it doesn't leak handles
 * into the chosen runner.
 */
async function pickRunner(): Promise<JobRunner> {
  const override = (process.env.OPENSHIP_JOB_RUNNER ?? "").toLowerCase().trim();
  if (override === "in-process") {
    return new InProcessJobRunner();
  }
  if (override === "bullmq") {
    return new BullMQJobRunner();
  }
  // Redis required (CLOUD_MODE / OPENSHIP_REQUIRE_REDIS): force BullMQ, skip the
  // probe. No silent in-process fallback — a SaaS replica MUST share the queue.
  if (REDIS_REQUIRED) {
    return new BullMQJobRunner();
  }
  // Auto-detect (self-hosted single-box): Redis if reachable, else in-process.
  return (await isRedisReachable()) ? new BullMQJobRunner() : new InProcessJobRunner();
}

/**
 * Return the module-level singleton runner, creating it on first call.
 * Callers race-safe via the resolvingPromise — multiple parallel
 * `getJobRunner()` calls share one detection pass.
 */
export async function getJobRunner(): Promise<JobRunner> {
  if (instance) return instance;
  if (resolvingPromise) return resolvingPromise;
  resolvingPromise = (async () => {
    const runner = await pickRunner();
    instance = runner;
    resolvingPromise = null;
    return runner;
  })();
  return resolvingPromise;
}

/** Replace the singleton — for tests that want to inject a fake. Do
 *  NOT use in production code; the auto-selector covers every
 *  legitimate case. */
export function setJobRunnerForTests(runner: JobRunner | null): void {
  instance = runner;
}
