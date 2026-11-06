"use client";

import { useCallback, useEffect, useRef } from "react";

/** Create once per flow, outside its component. Intents stay in this page's memory. */
export function createAutoSubmitIntent() {
  let pendingKey: string | null = null;
  return {
    prepare(key: string) {
      pendingKey = key;
    },
    consume(key: string) {
      const matches = pendingKey === key;
      pendingKey = null;
      return matches;
    },
    cancel(key: string | null) {
      if (pendingKey === key) pendingKey = null;
    },
  };
}

type AutoSubmitIntent = ReturnType<typeof createAutoSubmitIntent>;

/** Submit a prepared intent once when ready; the callback owns normal error handling. */
export function useAutoSubmit({
  intent,
  key,
  ready,
  onSubmit,
}: {
  intent: AutoSubmitIntent;
  /** Stable entry identity, including any scope that the caller must validate. */
  key: string | null;
  ready: boolean;
  onSubmit(): void | Promise<unknown>;
}) {
  const entry = useRef<{ intent: AutoSubmitIntent; key: string; queued: boolean } | null>(null);

  useEffect(() => {
    if (key === null) {
      entry.current = null;
      return;
    }
    if (entry.current?.intent !== intent || entry.current.key !== key) {
      entry.current = { intent, key, queued: intent.consume(key) };
    }
    if (!ready || !entry.current.queued) return;
    // Consume before calling: Strict Mode, rerenders and failures must not retry.
    entry.current.queued = false;
    void onSubmit();
  }, [intent, key, ready, onSubmit]);

  return useCallback(() => {
    if (entry.current?.intent === intent && entry.current.key === key) entry.current.queued = false;
    intent.cancel(key);
  }, [intent, key]);
}
