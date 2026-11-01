"use client";

import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import TerminalSurface from "./TerminalSurface";

/** Render a caller's existing log stream in the shared console. No second SSE
 * connection or deployment lifecycle is created by the presentation layer. */
export function LogSnapshotTerminal({ logs, emptyLabel }: { logs: string; emptyLabel: string }) {
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const previous = useRef<{ terminal: Terminal; logs: string } | null>(null);

  useEffect(() => {
    if (!terminal) return;
    const before = previous.current?.terminal === terminal ? previous.current.logs : "";
    const appended = logs.startsWith(before);
    const chunk = appended ? logs.slice(before.length) : logs;
    // Queue the reset with the replacement text. A synchronous reset could be
    // overtaken by old writes still waiting in xterm's asynchronous write queue.
    if (!appended || chunk) terminal.write(`${appended ? "" : "\x1bc"}${chunk}`);
    previous.current = { terminal, logs };
  }, [terminal, logs]);

  return (
    <>
      <TerminalSurface onReady={setTerminal} />
      {!logs.trim() && (
        <p className="pointer-events-none absolute inset-x-5 top-4 text-sm text-muted-foreground">
          {emptyLabel}
        </p>
      )}
    </>
  );
}
