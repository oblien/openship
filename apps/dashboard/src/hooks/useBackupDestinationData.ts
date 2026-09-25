"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api/client";

type Read<T> = () => Promise<{ data: T }>;
type State<T> = { read: Read<T>; data: T | null; error: unknown; refreshing: boolean };

/** Shared loading for the destination list and detail view. Refresh in place,
 *  ignore obsolete responses, and poll only while a visible page has active runs. */
export function useBackupDestinationData<T>(read: Read<T>, hasActiveRuns: (data: T) => boolean) {
  const [state, setState] = useState<State<T> | null>(null);
  const reader = useRef(read);
  reader.current = read;
  const mounted = useRef(false);
  const request = useRef<symbol | null>(null);

  const load = useCallback(
    async (supersede: boolean) => {
      if (!mounted.current || reader.current !== read || (request.current && !supersede)) return;
      const token = Symbol();
      request.current = token;
      setState((previous) => ({
        read,
        data: previous?.read === read ? previous.data : null,
        error: null,
        refreshing: true,
      }));
      try {
        const result = await read();
        if (request.current === token && reader.current === read)
          setState({ read, data: result.data, error: null, refreshing: false });
      } catch (error) {
        if (request.current === token && reader.current === read) {
          const unavailable = error instanceof ApiError && [401, 403, 404].includes(error.status);
          setState((previous) => ({
            read,
            data: !unavailable && previous?.read === read ? previous.data : null,
            error,
            refreshing: false,
          }));
        }
      } finally {
        if (request.current === token) request.current = null;
      }
    },
    [read],
  );

  useEffect(() => {
    mounted.current = true;
    void load(false);
    const refreshVisible = () => {
      if (document.visibilityState !== "hidden") void load(false);
    };
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      mounted.current = false;
      request.current = null;
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [load]);

  const current = state?.read === read ? state : null;
  const active = !!current?.data && !current.error && hasActiveRuns(current.data);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load(false);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const reload = useCallback(() => load(true), [load]);
  const refresh = useCallback(() => load(false), [load]);
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    refreshing: current?.refreshing ?? true,
    reload,
    refresh,
  };
}
