"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from "react";
import { parseDraft, type DraftAction, type ScaleDraft } from "./topology";

export function useTopologyStorage(
  storageKey: string,
  draft: ScaleDraft,
  dispatch: Dispatch<DraftAction>,
) {
  const serialized = useMemo(() => JSON.stringify(draft), [draft]);
  const initialSnapshot = useRef(serialized);
  const [ready, setReady] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState(initialSnapshot.current);
  const [notice, setNotice] = useState("");
  const [blocked, setBlocked] = useState(false);
  const dirty = ready && serialized !== savedSnapshot;

  useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const restored = parseDraft(stored);
        if (restored) {
          dispatch({ type: "restore", draft: restored });
          setSavedSnapshot(JSON.stringify(restored));
        } else {
          setBlocked(true);
          setNotice("The saved layout is incompatible. It has not been replaced.");
        }
      }
    } catch {
      setNotice("Local storage is unavailable. Changes stay in this session.");
    }
    setReady(true);
  }, [storageKey, dispatch]);

  const persist = useCallback(
    (replace = false) => {
      if (blocked && !replace) return false;
      if (!parseDraft(serialized)) {
        setNotice("Check the node configuration before saving this layout locally.");
        return false;
      }
      try {
        localStorage.setItem(storageKey, serialized);
        setSavedSnapshot(serialized);
        setNotice("");
        setBlocked(false);
        return true;
      } catch {
        setNotice("Changes could not be saved locally. Retry or export the topology.");
        return false;
      }
    },
    [blocked, serialized, storageKey],
  );

  useEffect(() => {
    if (!dirty || blocked) return;
    const timer = window.setTimeout(() => persist(), 400);
    return () => window.clearTimeout(timer);
  }, [dirty, blocked, persist]);

  const latest = useRef({ dirty, persist });
  useEffect(() => {
    latest.current = { dirty, persist };
  }, [dirty, persist]);

  useEffect(() => {
    const flush = () => {
      if (latest.current.dirty) latest.current.persist();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (latest.current.dirty && !latest.current.persist()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", beforeUnload);
      flush();
    };
  }, []);

  return { ready, notice, blocked, retry: () => persist(blocked) };
}
