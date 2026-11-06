"use client";

import { useCallback, useEffect, useRef } from "react";

// A one-shot intent from a same-tab action, not from URL parameters or storage.
// Refreshes, copied links and new tabs retain the editable investigation draft.
let pendingHref: string | null = null;

export function prepareInvestigationAutoSend(href: string) {
  pendingHref = href;
}

export function useInvestigationAutoSend({
  href,
  ready,
  onSend,
}: {
  /** Canonical URL, including the validated account/workspace/connection scope. */
  href: string | null;
  ready: boolean;
  onSend(): Promise<boolean>;
}) {
  const intent = useRef<{ href: string; queued: boolean } | null>(null);

  useEffect(() => {
    if (!href) {
      intent.current = null;
      return;
    }
    if (intent.current?.href !== href) {
      intent.current = { href, queued: pendingHref === href };
      pendingHref = null;
    }
    if (!ready || !intent.current.queued) return;
    // Consume before sending: Strict Mode, polling, failures and reconnects must
    // not replay a turn. Failed sends retain the normal composer/retry behavior.
    intent.current.queued = false;
    void onSend();
  }, [href, ready, onSend]);

  return useCallback(() => {
    if (intent.current) intent.current.queued = false;
    if (pendingHref === href) pendingHref = null;
  }, [href]);
}
