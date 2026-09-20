/**
 * Shared types for custom job config. `actionConfig` (jsonb on the job row)
 * holds a CommandConfig for command jobs; `secrets` values are encrypted at
 * rest (see job.service `encrypt`) and decrypted only at execution time.
 */

export interface JobRetryConfig {
  maxAttempts: number;
  backoffSeconds: number;
}

export interface CommandConfig {
  /** Single-server target (legacy / most jobs). */
  serverId?: string;
  /** Multi-server fan-out; when >1 the executor runs on each. */
  serverIds?: string[];
  command?: string;
  timeoutMs?: number;
  retry?: JobRetryConfig;
  /** Plain env vars prepended to the command. */
  env?: Record<string, string>;
  /** Secret env vars, encrypted at rest; merged with `env` at run time. */
  secrets?: Record<string, string>;
}

export const JOB_RUN_STATES = ["running", "success", "failed"] as const;
export type JobRunState = (typeof JOB_RUN_STATES)[number];

export interface JobNotifyConfig {
  channels: string[];
  states: JobRunState[];
}

/** Normalize serverId/serverIds into a deduped list (order-preserving). */
export function resolveServerIds(cfg: {
  serverId?: string;
  serverIds?: string[];
}): string[] {
  const out: string[] = [];
  for (const id of [...(cfg.serverIds ?? []), ...(cfg.serverId ? [cfg.serverId] : [])]) {
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
