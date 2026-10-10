"use client";
import { useCallback, useState } from "react";

/** Canvas, list, YAML and trigger controls share one reversible draft. */
export function useWorkflowDraft(initial: string) {
  const [history, setHistory] = useState({
    source: initial,
    past: [] as string[],
    future: [] as string[],
  });
  const change = useCallback(
    (source: string) =>
      setHistory((current) =>
        current.source === source
          ? current
          : {
              source,
              past: [...current.past.slice(-29), current.source],
              future: [],
            },
      ),
    [],
  );
  const reset = useCallback((source: string) => setHistory({ source, past: [], future: [] }), []);
  const undo = () =>
    setHistory((current) =>
      !current.past.length
        ? current
        : {
            source: current.past.at(-1)!,
            past: current.past.slice(0, -1),
            future: [current.source, ...current.future],
          },
    );
  const redo = () =>
    setHistory((current) =>
      !current.future.length
        ? current
        : {
            source: current.future[0]!,
            past: [...current.past, current.source],
            future: current.future.slice(1),
          },
    );
  return {
    source: history.source,
    change,
    reset,
    undo,
    redo,
    canUndo: !!history.past.length,
    canRedo: !!history.future.length,
  };
}
