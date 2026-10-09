"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { getApiErrorMessage } from "@/lib/api/client";

/** Keep observations and mutation completions bound to the selected account
 * and server, including replies arriving after navigation or tab unmount. */
export function useManagedServerResource<T>(serverId: string, read: (id: string) => Promise<T>) {
  const account = useCloudResourceKey();
  const key = `${account}:${serverId}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const epoch = useRef(0);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    error: string | null;
    busy: boolean;
  }>({ key, data: null, error: null, busy: true });
  useEffect(() => {
    mounted.current = true;
    const sequence = ++epoch.current;
    inFlight.current = false;
    setState((previous) => ({
      key,
      data: previous.key === key ? previous.data : null,
      error: null,
      busy: true,
    }));
    void read(serverId)
      .then((data) => {
        if (mounted.current && currentKey.current === key && epoch.current === sequence)
          setState({ key, data, error: null, busy: false });
      })
      .catch((error) => {
        if (mounted.current && currentKey.current === key && epoch.current === sequence)
          setState((previous) => ({ ...previous, error: getApiErrorMessage(error), busy: false }));
      });
    return () => {
      mounted.current = false;
      ++epoch.current;
    };
  }, [key, serverId, read, attempt]);
  async function run<R>(work: () => Promise<R>, accept: (value: R) => void) {
    if (inFlight.current || !mounted.current || state.busy || state.key !== key) return;
    const sequence = ++epoch.current;
    inFlight.current = true;
    setState((previous) => ({ ...previous, busy: true, error: null }));
    try {
      const result = await work();
      if (mounted.current && currentKey.current === key && epoch.current === sequence)
        accept(result);
    } catch (error) {
      if (mounted.current && currentKey.current === key && epoch.current === sequence)
        setState((previous) => ({ ...previous, error: getApiErrorMessage(error) }));
    } finally {
      if (mounted.current && currentKey.current === key && epoch.current === sequence) {
        inFlight.current = false;
        setState((previous) => ({ ...previous, busy: false }));
      }
    }
  }
  return {
    data: state.key === key ? state.data : null,
    error: state.key === key ? state.error : null,
    busy: state.key !== key || state.busy,
    refresh: () => {
      if (!inFlight.current) setAttempt((value) => value + 1);
    },
    replace: (data: T) => setState((previous) => ({ ...previous, key, data })),
    run,
  };
}

/** Connection material lives only in memory, briefly. Never cache in query
 * stores, localStorage, URLs, toast messages or server overview state. */
export function useManagedServerSecret<T>(serverId: string) {
  const account = useCloudResourceKey();
  const key = `${account}:${serverId}`;
  const [value, setValue] = useState<{ key: string; secret: T } | null>(null);
  const clear = useCallback(() => setValue(null), []);
  useEffect(clear, [key, clear]);
  useEffect(() => {
    if (!value) return;
    const timer = setTimeout(clear, 60_000);
    const hidden = () => {
      if (document.hidden) clear();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [value, clear]);
  return {
    value: value?.key === key ? value.secret : null,
    reveal: (secret: T) => {
      if (!document.hidden) setValue({ key, secret });
    },
    clear,
  };
}
