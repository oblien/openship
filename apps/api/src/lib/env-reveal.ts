import { AppError } from "@repo/core";

/**
 * #336 per-key env reveal — the one place that turns "the whole env map" into
 * "exactly the keys the caller named".
 *
 * All three reveal sources (a service row, an upload session, a container's
 * `docker inspect`) hand back a full map, so without this every eye-press shipped
 * every secret of that service to the browser: 32 plaintext values in the network
 * response, in memory and in the devtools log to see one.
 *
 * `keys` is REQUIRED and non-empty on purpose — there is no request shape that
 * means "give me everything". A caller must already know a key's name to see its
 * value, and the audit row (`auditAfter.revealedEnvKeys`) records exactly which
 * secrets were disclosed instead of an unqualified "revealed env".
 */

/** Bound on one request. Generous for a real service, cheap abuse guard. */
export const MAX_REVEAL_KEYS = 500;
const MAX_KEY_LENGTH = 512;

/** Validate a client-sent `keys` list. Throws AppError(400) — the global error
 *  handler renders it; callers don't need their own branch. */
export function parseRevealKeys(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new AppError("keys must be a non-empty array of env var names", 400);
  }
  if (input.length > MAX_REVEAL_KEYS) {
    throw new AppError(`keys accepts at most ${MAX_REVEAL_KEYS} names per request`, 400);
  }
  const seen = new Set<string>();
  for (const key of input) {
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
      throw new AppError("keys must contain only non-empty env var names", 400);
    }
    seen.add(key);
  }
  return [...seen];
}

/**
 * Return ONLY the requested keys that actually exist in `env`. `hasOwn` rather
 * than `key in env`: `keys` is client-controlled, and `in` would happily resolve
 * `constructor` / `toString` off the prototype and answer with a function.
 */
export function pickRevealed(
  env: Record<string, string> | null | undefined,
  keys: string[],
): Record<string, string> {
  const revealed: Record<string, string> = {};
  if (!env) return revealed;
  for (const key of keys) {
    if (Object.hasOwn(env, key)) revealed[key] = env[key];
  }
  return revealed;
}
