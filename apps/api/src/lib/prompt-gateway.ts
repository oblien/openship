/**
 * Shared "hold and wait for the user's decision" registry.
 *
 * The deploy-session manager (session-manager.ts) and the server-setup-session
 * manager (setup-session.ts) each carried their OWN identical copy of the
 * block-on-a-promise + 5-minute-timeout map keyed by session id. This is that
 * mechanic, extracted once.
 *
 * What stays in each caller: the session-object storage of the current prompt
 * (for replay to reconnecting subscribers) and the SSE broadcast — those
 * genuinely differ between the two (seq cursor, disconnect-grace), so the
 * registry owns ONLY the promise/timeout lifecycle, not the transport.
 */

import type { PromptPayload } from "@repo/adapters";
import { env } from "../config/env";

// Re-exported so callers get the one shared prompt shape from here too.
export type { PromptPayload };

const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * If the user never answers, the awaiting pipeline aborts after this.
 *
 * Five minutes is tuned for a human looking at a modal. An API client has to
 * POLL to discover the prompt exists at all, so the same window can expire
 * before it ever notices — hence the override. The default is unchanged, and the
 * deadline is published on the prompt as `expiresAt` so a poller can pace itself
 * instead of guessing.
 *
 * Not unbounded on purpose: the hold is an in-memory promise, so a very long
 * window just means a deploy occupying a session for that long, and it cannot
 * survive an API restart either way.
 */
export const PROMPT_TIMEOUT_MS = (() => {
  const raw = Number(env.OPENSHIP_PROMPT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROMPT_TIMEOUT_MS;
})();

interface Pending {
  resolve: (action: string) => void;
  reject: (reason: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class PromptRegistry {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs: number = PROMPT_TIMEOUT_MS) {}

  /**
   * When a hold started now would expire, as an ISO string — for stamping
   * `PromptPayload.expiresAt`. Lives here so the published deadline and the
   * actual `setTimeout` can't drift apart.
   */
  deadlineFromNow(): string {
    return new Date(Date.now() + this.timeoutMs).toISOString();
  }

  /**
   * Block until `respond`/`reject`/timeout for this key. `onTimeout` runs just
   * before the promise rejects, so the caller can clear its held prompt in sync
   * with the registry (matching the pre-extraction behaviour).
   */
  wait(key: string, onTimeout?: () => void): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(key);
        onTimeout?.();
        reject(new Error("Prompt timed out - no response from user"));
      }, this.timeoutMs);
      this.pending.set(key, { resolve, reject, timeoutId });
    });
  }

  /** Resolve the pending prompt with the chosen action. False if none pending. */
  respond(key: string, action: string): boolean {
    const p = this.pending.get(key);
    if (!p) return false;
    clearTimeout(p.timeoutId);
    this.pending.delete(key);
    p.resolve(action);
    return true;
  }

  /** Reject + clear the pending prompt (teardown / disconnect). No-op if none. */
  reject(key: string, reason: string): boolean {
    const p = this.pending.get(key);
    if (!p) return false;
    clearTimeout(p.timeoutId);
    this.pending.delete(key);
    p.reject(new Error(reason));
    return true;
  }

  has(key: string): boolean {
    return this.pending.has(key);
  }
}
