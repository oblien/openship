import type { Pool } from "pg";
import { sleep } from "@repo/core";

function positiveMs(value: unknown, fallback: number): number {
  const parsed = value === undefined || value === null ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const PG_READY_BUDGET_MS = 90_000;
const PG_READY_RETRY_MS = 1_000;

/**
 * Connection failures that no amount of waiting will fix, so boot fails NOW with the
 * real error instead of after the budget.
 *
 * Keeping this list — rather than an allowlist of retryable errors — is deliberate:
 * this whole wait exists because an error class we hadn't enumerated (Bun labelling a
 * DNS miss `ECONNREFUSED`) turned a two-second delay into a permanent crash loop. An
 * unknown error costs one bounded wait and then reports itself; an unknown error we
 * refuse to retry costs the operator their install.
 *
 * 28P01/28000 are the #488 signal (`.env` no longer matches the data volume) and 3D000
 * is a missing database — each needs an operator, and each must stay fast and legible.
 */
const FATAL_PG_CONNECT_CODES = new Set(["28P01", "28000", "3D000"]);

function isFatalConnectError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && FATAL_PG_CONNECT_CODES.has(code);
}

/**
 * Block until the pool hands out a working connection, or the budget runs out.
 *
 * Acquire-and-release rather than a query: it exercises DNS, the TCP connect and the
 * auth handshake — every layer that can be "not ready yet" — and nothing else.
 *
 * Not re-exported by the package barrel; `budgetMs`/`retryMs` are overridable so the
 * tests can drive the budget-exhausted path without sitting through it.
 */
export async function awaitPgReady(
  pool: Pool,
  opts: { budgetMs?: number; retryMs?: number } = {},
): Promise<void> {
  // Normalized through the same guard as the env override: a NaN budget would make
  // every deadline comparison false and hang boot indefinitely.
  const budgetMs = positiveMs(opts.budgetMs, PG_READY_BUDGET_MS);
  const retryMs = positiveMs(opts.retryMs, PG_READY_RETRY_MS);
  const startedAt = Date.now();
  let attempt = 0;

  for (;;) {
    attempt++;
    try {
      const client = await pool.connect();
      client.release();
      if (attempt > 1) {
        const waited = Math.round((Date.now() - startedAt) / 1000);
        console.log(`[db] postgres accepted a connection after ${waited}s (${attempt} attempts)`);
      }
      return;
    } catch (err) {
      if (isFatalConnectError(err)) throw err;

      const elapsed = Date.now() - startedAt;
      if (elapsed + retryMs >= budgetMs) {
        // Re-thrown as-is: the driver's message names the host, port and cause, and
        // that is what the operator needs to see at the top of the crash.
        throw err;
      }
      // One line on the first miss, then every 10th, so a slow start is visible in
      // `docker logs` without burying it.
      if (attempt === 1 || attempt % 10 === 0) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(
          `[db] postgres not ready yet (attempt ${attempt}, ${Math.round(elapsed / 1000)}s` +
            `/${Math.round(budgetMs / 1000)}s): ${reason}`,
        );
      }
      await sleep(retryMs);
    }
  }
}

