"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/auth-client";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { getApiErrorMessage } from "@/lib/api/client";

export function useActionScope() {
  const { data: session } = useSession();
  const cloud = useCloudResourceKey();
  return `${session?.user.id ?? "local"}:${session?.session.activeOrganizationId ?? ""}:${cloud}`;
}

/** A single in-flight refresh; stale results can never populate another account. */
export function useActionResource<T>(
  fetcher: () => Promise<T>,
  interval: number | ((data: T) => number) = 0,
) {
  const scope = useActionScope();
  const [state, setState] = useState<{
    owner: string;
    source: typeof fetcher;
    data: T | null;
    error: string | null;
    loading: boolean;
  }>({ owner: scope, source: fetcher, data: null, error: null, loading: true });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = typeof interval === "number" ? interval : 5000;
      try {
        const data = await fetcher();
        delay = typeof interval === "number" ? interval : interval(data);
        if (active) setState({ owner: scope, source: fetcher, data, error: null, loading: false });
      } catch (error) {
        if (active)
          setState((previous) => ({
            owner: scope,
            source: fetcher,
            data: previous.owner === scope && previous.source === fetcher ? previous.data : null,
            error: getApiErrorMessage(error),
            loading: false,
          }));
      } finally {
        const next = () => {
          if (!active) return;
          if (document.visibilityState === "visible") void poll();
          else timer = setTimeout(next, delay);
        };
        if (active && delay) timer = setTimeout(next, delay);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [fetcher, interval, scope, revision]);
  const current = state.owner === scope && state.source === fetcher;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: !current || state.loading,
    refresh,
  };
}

export function useActionMutation() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const execute = async <T>(operation: () => Promise<T>): Promise<T | null> => {
    if (pending.current) return null;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      return active.current ? result : null;
    } catch (error) {
      if (active.current) setError(getApiErrorMessage(error));
      return null;
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };
  return { execute, busy, error, setError };
}
