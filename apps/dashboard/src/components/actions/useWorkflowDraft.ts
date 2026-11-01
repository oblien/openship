"use client";
import { useCallback, useState } from "react";

/** Canvas, list, YAML and trigger controls share one reversible draft. */
type History = { source: string; past: string[]; future: string[] };
export function useWorkflowDraft(initial: string, key = "workflow") {
  const [histories, setHistories] = useState<Record<string, History>>({});
  const history = histories[key] ?? { source: initial, past: [], future: [] };
  const setHistory = useCallback(
    (update: History | ((current: History) => History)) => {
      setHistories((all) => ({
        ...all,
        [key]:
          typeof update === "function"
            ? update(all[key] ?? { source: initial, past: [], future: [] })
            : update,
      }));
    },
    [key, initial],
  );
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
    [setHistory],
  );
  const reset = useCallback(
    (source: string, targetKey = key) =>
      setHistories((current) => ({ ...current, [targetKey]: { source, past: [], future: [] } })),
    [key],
  );
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
    initialized: Object.hasOwn(histories, key),
    sourceFor: (key: string) => histories[key]?.source,
    change,
    reset,
    undo,
    redo,
    canUndo: !!history.past.length,
    canRedo: !!history.future.length,
  };
}
