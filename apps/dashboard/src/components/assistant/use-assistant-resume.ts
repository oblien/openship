"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantConversation } from "@repo/contracts";

/** Store an ID only. This is a navigation preference, never an authorization. */
export function assistantResumeKey(scope: string, clientId: string, targetId: string) {
  return `openship.assistant.lastChat:${JSON.stringify([scope, clientId, targetId])}`;
}

export function useAssistantResume({
  scope,
  clientId,
  targetId,
  ready,
  search,
  chats,
  loading,
  error,
  onResume,
}: {
  scope: string;
  clientId: string;
  targetId: string;
  ready: boolean;
  search: string;
  chats: AssistantConversation[] | null;
  loading: boolean;
  error: string | null;
  onResume(id: string): void;
}) {
  const key = assistantResumeKey(scope, clientId, targetId);
  const params = new URLSearchParams(search);
  const explicit =
    params.has("chat") ||
    params.has("new") ||
    params.has("investigate") ||
    params.has("automation");
  const entry = JSON.stringify([key, search]);
  const handled = useRef<string | null>(null);
  const [resolution, setResolution] = useState<{ entry: string; id: string | null } | null>(null);

  useEffect(() => {
    if (explicit) {
      handled.current = null;
      setResolution(null);
      return;
    }
    if (!ready || handled.current === entry || (!error && (loading || !chats))) return;
    handled.current = entry;
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem(key);
    } catch {
      /* diagnostics-ignore: Unavailable storage falls back to the currently authorized scoped conversation list. */
      // Storage can be unavailable; the scoped list still provides a recent chat.
    }
    const allowed = error ? [] : (chats ?? []);
    const newest = allowed.reduce<AssistantConversation | null>(
      (latest, chat) => (!latest || chat.updatedAt > latest.updatedAt ? chat : latest),
      null,
    );
    const id = allowed.find((chat) => chat.id === remembered)?.id ?? newest?.id ?? null;
    setResolution({ entry, id });
    if (id) onResume(id);
  }, [explicit, ready, entry, error, loading, chats, key, onResume]);

  const remember = useCallback(
    (id: string) => {
      if (!ready) return;
      try {
        localStorage.setItem(key, id);
      } catch {
        /* diagnostics-ignore: Persisting a resume hint is optional; live scope validation remains authoritative. */
      }
    },
    [key, ready],
  );
  const forget = useCallback(
    (id: string) => {
      if (!ready) return;
      try {
        if (localStorage.getItem(key) === id) localStorage.removeItem(key);
      } catch {
        /* diagnostics-ignore: Removing a resume hint is optional; live scope validation remains authoritative. */
      }
    },
    [key, ready],
  );
  const cancel = useCallback(() => {
    // A click on New chat wins even if a delayed history request finishes first.
    handled.current = entry;
    setResolution({ entry, id: null });
  }, [entry]);

  return {
    resolving: !explicit && (!ready || resolution?.entry !== entry || !!resolution.id),
    remember,
    forget,
    cancel,
  };
}
