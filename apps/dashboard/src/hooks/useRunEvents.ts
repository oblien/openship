"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getActiveOrganizationId, getApiBaseUrl } from "@/lib/api/client";
import { useSSEStream, type SSEMessage } from "./useSSEStream";

export interface RunEventsState {
  connected: boolean;
  reconnecting: boolean;
  error: Error | null;
  reconnect(): void;
}

/** Read-only run subscription. Reconnection can never replay a start/retry POST. */
export function useRunEvents<T>(path: string | null, onSnapshot: (run: T) => void): RunEventsState {
  const callback = useRef(onSnapshot);
  callback.current = onSnapshot;
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  const control = useRef<{
    active: boolean;
    complete: boolean;
    permanent: boolean;
    snapshot: boolean;
  }>({
    active: false,
    complete: false,
    permanent: false,
    snapshot: false,
  });
  const disconnect = useRef<() => void>(() => {});
  const onError = useCallback((err: Error) => {
    if (!control.current.active) return;
    const status = (err as Error & { status?: number }).status;
    control.current.permanent =
      status === 400 || status === 401 || status === 403 || status === 404 || status === 501;
    if (control.current.permanent) setReconnecting(false);
    setError(err);
    setConnected(false);
    disconnect.current();
  }, []);
  const onMessage = useCallback(
    (message: SSEMessage) => {
      if (!control.current.active) return;
      if (message.type === "snapshot") {
        if (!message.run || typeof message.run !== "object")
          throw new Error("Invalid run progress snapshot");
        callback.current(message.run as T);
        control.current.snapshot = true;
        setError(null);
        setReconnecting(false);
      } else if (message.type === "complete") {
        // Never accept an incomplete replay as a successful connection.
        if (!control.current.snapshot)
          throw new Error("The progress stream ended without a saved snapshot");
        control.current.complete = true;
        setReconnecting(false);
        disconnect.current();
      } else if (message.type === "error") {
        onError(
          Object.assign(
            new Error(message.error || message.message || "Live progress connection failed"),
            {
              status: message.status,
            },
          ),
        );
        disconnect.current();
      }
    },
    [onError],
  );
  const stream = useSSEStream({
    autoWriteToTerminal: false,
    onRawMessage: onMessage,
    onConnect: useCallback(() => {
      if (control.current.active) setConnected(true);
    }, []),
    onDisconnect: useCallback(() => {
      if (control.current.active) setConnected(false);
    }, []),
    onError,
  });
  disconnect.current = stream.disconnect;
  const connect = stream.connect;
  const close = stream.disconnect;

  useEffect(() => {
    setConnected(false);
    setReconnecting(false);
    setError(null);
    if (!path) return;
    const owner = { active: true, complete: false, permanent: false, snapshot: false };
    control.current = owner;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let firstSnapshot: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let pending = false;
    const organizationId = getActiveOrganizationId();
    const open = async () => {
      if (!owner.active || owner.complete || owner.permanent || pending) return;
      pending = true;
      owner.snapshot = false;
      const openedAt = Date.now();
      firstSnapshot = setTimeout(() => {
        if (owner.active && !owner.snapshot) {
          onError(new Error("Loading saved progress timed out"));
          close();
        }
      }, 60_000);
      try {
        await connect(`${getApiBaseUrl()}${path}`, {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            ...(organizationId ? { "X-Organization-Id": organizationId } : {}),
          },
          connectTimeoutMs: 60_000,
          idleTimeoutMs: 60_000,
        });
      } finally {
        pending = false;
        clearTimeout(firstSnapshot);
        if (!owner.active || owner.complete || owner.permanent) return;
        // Opening headers or one snapshot is not enough to reset backoff: a
        // proxy that immediately closes each stream must not create a storm.
        if (owner.snapshot && Date.now() - openedAt >= 30_000) failures = 0;
        const delay = Math.min(1000 * 2 ** Math.min(failures++, 4), 15_000);
        setReconnecting(true);
        timer = setTimeout(
          () => {
            timer = undefined;
            void open();
          },
          delay + Math.random() * delay * 0.2,
        );
      }
    };
    const online = () => {
      if (!owner.active || owner.complete || owner.permanent || !timer) return;
      clearTimeout(timer);
      timer = undefined;
      void open();
    };
    window.addEventListener("online", online);
    void open();
    return () => {
      owner.active = false;
      clearTimeout(timer);
      clearTimeout(firstSnapshot);
      window.removeEventListener("online", online);
      close();
    };
  }, [path, attempt, connect, close, onError]);

  return {
    connected,
    reconnecting,
    error,
    reconnect: useCallback(() => setAttempt((value) => value + 1), []),
  };
}
