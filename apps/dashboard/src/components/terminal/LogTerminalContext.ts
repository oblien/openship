"use client";

import { createContext, useContext, useEffect, type Dispatch, type SetStateAction } from "react";
import type { Terminal } from "@xterm/xterm";

/** A log panel's actions belong only to the terminal currently visible inside it. */
export const LogTerminalContext = createContext<{
  setTerminal: Dispatch<SetStateAction<Terminal | null>>;
  isFollowing: boolean;
} | null>(null);

export function useLogTerminal(terminal: Terminal | null, active: boolean) {
  const context = useContext(LogTerminalContext);
  const setTerminal = context?.setTerminal;
  useEffect(() => {
    if (!active || !terminal || !setTerminal) return;
    setTerminal(terminal);
    return () => setTerminal(current => current === terminal ? null : current);
  }, [active, terminal, setTerminal]);
  return context?.isFollowing ?? true;
}
