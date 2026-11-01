/**
 * @module @/lib/persisted-value
 *
 * Tiny typed wrapper around `localStorage` for "remember this between sessions"
 * values - the soft per-browser memory pattern (last-picked deploy target,
 * dismissed banners, "I've seen the welcome" flags, etc.).
 *
 * Why a helper instead of inlining:
 *  - SSR-safe (no `window` reference at module scope).
 *  - JSON parse failures don't crash the caller.
 *  - Validation is a required argument - each consumer enforces its own shape
 *    so a stale or tampered entry can't masquerade as the new type.
 *  - Quota / private-mode write failures are swallowed (soft memory is
 *    best-effort by definition).
 *
 * Usage:
 *   const lastPick = createPersistedValue<LastPick>(
 *     "openship.deploy-last-pick",
 *     (v): v is LastPick =>
 *       typeof v === "object" && v !== null &&
 *       ["local", "server", "cloud"].includes((v as LastPick).target),
 *   );
 *   const remembered = lastPick.read();
 *   lastPick.write({ target: "server", serverId: "abc" });
 *
 * For boolean "seen-once" flags, prefer `createPersistedFlag` below - it
 * skips JSON entirely and stores a single "1" / absent.
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
export interface PersistedValue<T> {
  read(): T | null;
  write(value: T): void;
  clear(): void;
}

/**
 * Create a typed JSON-backed localStorage cell.
 *
 * The validator runs on every read; any parse / shape failure returns null
 * rather than throwing. Treat null as "no value" - never as an error to
 * surface to the user.
 */
export function createPersistedValue<T>(
  key: string,
  validate: (raw: unknown) => raw is T,
): PersistedValue<T> {
  return {
    read(): T | null {
      if (typeof window === "undefined") return null;
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return validate(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    write(value: T): void {
      if (typeof window === "undefined") return;
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/lib/persisted-value"); /* quota / private mode - soft memory is best-effort */ }
    },
    clear(): void {
      if (typeof window === "undefined") return;
      try {
        window.localStorage.removeItem(key);
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/lib/persisted-value"); /* same - best-effort */ }
    },
  };
}

export interface PersistedFlag {
  isSet(): boolean;
  set(): void;
  clear(): void;
}

/**
 * Create a boolean "seen-once" flag in localStorage. Stores `"1"` when set,
 * absent when not. Cheaper than `createPersistedValue<boolean>` because it
 * skips JSON.
 */
export function createPersistedFlag(key: string): PersistedFlag {
  return {
    isSet(): boolean {
      if (typeof window === "undefined") return false;
      try {
        return window.localStorage.getItem(key) === "1";
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/lib/persisted-value");
        return false;
      }
    },
    set(): void {
      if (typeof window === "undefined") return;
      try {
        window.localStorage.setItem(key, "1");
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/lib/persisted-value"); /* best-effort */ }
    },
    clear(): void {
      if (typeof window === "undefined") return;
      try {
        window.localStorage.removeItem(key);
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/lib/persisted-value"); /* best-effort */ }
    },
  };
}
