"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendAssistantEvents,
  isAssistantActive,
  type AssistantActivity,
  type AssistantSnapshot,
} from "@repo/contracts";
import { assistantApi } from "@/lib/api/assistant";
import { getApiErrorMessage } from "@/lib/api/client";

export function mergeAssistantActivity(
  snapshot: AssistantSnapshot,
  activity: AssistantActivity,
): AssistantSnapshot {
  if (activity.runId === snapshot.activity.runId && activity.cursor < snapshot.activity.cursor)
    return snapshot;
  const events =
    activity.runId === snapshot.activity.runId
      ? activity.events.filter((e) => e.sequence > snapshot.activity.cursor)
      : activity.events;
  return {
    ...snapshot,
    conversation: { ...snapshot.conversation, state: activity.state },
    activity: { ...activity, events: [] },
    messages: appendAssistantEvents(snapshot.messages, events, activity.runId ?? ""),
  };
}
export function useConversation(id: string | null) {
  const [stored, setStored] = useState<AssistantSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const current = useRef(id);
  current.current = id;
  const snapshot = stored?.conversation.id === id ? stored : null;
  const latest = useRef(snapshot);
  latest.current = snapshot;
  useEffect(() => {
    if (!id) return;
    // Permissions may have been edited in Settings or another tab while a
    // completed conversation was idle. Re-read its authoritative access state.
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") setRevision((value) => value + 1);
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [id]);
  const apply = useCallback(
    (activity: AssistantActivity) =>
      setStored((previous) =>
        previous?.conversation.id === current.current
          ? mergeAssistantActivity(previous, activity)
          : previous,
      ),
    [],
  );
  useEffect(() => {
    if (!id) {
      setStored(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await assistantApi.get(id, controller.signal);
        if (controller.signal.aborted) return;
        latest.current = next;
        setStored(next);
        setError(null);
        if (isAssistantActive(next.activity.state) && !next.accessChanged) void watch();
      } catch (error) {
        if (!controller.signal.aborted) setError(getApiErrorMessage(error));
      }
    };
    const watch = async () => {
      try {
        const value = latest.current;
        if (!value || value.conversation.id !== id || !isAssistantActive(value.activity.state))
          return;
        const activity = await assistantApi.activity(
          id,
          { runId: value.activity.runId, after: value.activity.cursor },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (latest.current?.activity.runId !== value.activity.runId) {
          timer = setTimeout(() => void watch(), 80);
          return;
        }
        if (activity.reset) {
          await read();
          return;
        }
        const next = mergeAssistantActivity(latest.current ?? value, activity);
        latest.current = next;
        setStored(next);
        setError(null);
        if (isAssistantActive(activity.state)) timer = setTimeout(() => void watch(), 80);
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(getApiErrorMessage(error));
          timer = setTimeout(() => void read(), 3000);
        }
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, revision]);
  return {
    snapshot,
    error,
    apply,
    refresh: useCallback(() => setRevision((n) => n + 1), []),
    setSnapshot: setStored,
  };
}
