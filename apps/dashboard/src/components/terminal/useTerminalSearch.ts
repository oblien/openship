"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";

/** Native xterm search follows the visible buffer without filtering or rewriting its logs. */
export function useTerminalSearch(terminal: Terminal | null) {
  const [value, onChange] = useState("");
  const [loaded, setLoaded] = useState<{ terminal: Terminal; addon: SearchAddon } | null>(null);
  const [hasMatches, setHasMatches] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const addon = loaded?.terminal === terminal ? loaded.addon : null;
  const matched = useRef(false);

  useEffect(() => {
    setError(null);
    setLoaded(null);
    if (!terminal) return;
    let disposed = false;
    let searchAddon: SearchAddon | undefined;
    void import("@xterm/addon-search").then(({ SearchAddon }) => {
      if (disposed) return;
      searchAddon = new SearchAddon();
      terminal.loadAddon(searchAddon);
      setLoaded({ terminal, addon: searchAddon });
    }).catch(error => {
      if (!disposed) setError(error instanceof Error ? error : new Error(String(error)));
    });
    return () => {
      disposed = true;
      searchAddon?.dispose();
    };
  }, [terminal]);

  const find = useCallback((direction: "next" | "previous", incremental = false) => {
    if (!addon || !value) return;
    matched.current = direction === "next"
      ? addon.findNext(value, { incremental })
      : addon.findPrevious(value);
    setHasMatches(matched.current);
  }, [addon, value]);

  useEffect(() => {
    matched.current = false;
    setHasMatches(false);
    setSearching(false);
    if (!addon || !terminal) return;
    if (!value) {
      addon.clearDecorations();
      terminal.clearSelection();
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const search = () => {
      timer = undefined;
      find("next", true);
      setSearching(false);
    };
    const schedule = () => {
      if (timer === undefined) timer = setTimeout(search, 150);
    };
    setSearching(true);
    schedule();
    // A query can precede the first log line. Retry as data arrives until it
    // matches, then leave the user's selected result and scroll position alone.
    const writes = terminal.onWriteParsed(() => { if (!matched.current) schedule(); });
    return () => {
      clearTimeout(timer);
      writes.dispose();
    };
  }, [addon, terminal, value, find]);

  return {
    value,
    onChange,
    hasMatches,
    searching,
    disabled: !addon,
    error,
    onNext: () => find("next"),
    onPrevious: () => find("previous"),
  };
}
