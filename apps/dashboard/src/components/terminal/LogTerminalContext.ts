"use client";

import { createContext, useContext, useEffect, type Dispatch, type SetStateAction } from "react";
import type { Terminal } from "@xterm/xterm";

export type LogTerminalFollowController = {
  isFollowing: boolean;
  pauseForInspection: () => void;
  resume: () => void;
  toggle: () => void;
};

/** A log panel's actions belong only to the terminal currently visible inside it. */
export const LogTerminalContext = createContext<{
  setTerminal: Dispatch<SetStateAction<Terminal | null>>;
  registerFollow: (terminal: Terminal, controller: LogTerminalFollowController) => void;
  unregisterFollow: (terminal: Terminal) => void;
} | null>(null);

export function useLogTerminal(
  terminal: Terminal | null,
  active: boolean,
  follow: LogTerminalFollowController | null = null,
) {
  const context = useContext(LogTerminalContext);
  const setTerminal = context?.setTerminal;
  const registerFollow = context?.registerFollow;
  const unregisterFollow = context?.unregisterFollow;

  useEffect(() => {
    if (!active || !terminal || !setTerminal) return;
    setTerminal(terminal);
    return () => {
      setTerminal(current => current === terminal ? null : current);
      unregisterFollow?.(terminal);
    };
  }, [active, terminal, setTerminal, unregisterFollow]);

  useEffect(() => {
    if (!active || !terminal || !follow || !registerFollow) return;
    registerFollow(terminal, follow);
  }, [active, terminal, follow?.isFollowing, follow?.pauseForInspection, follow?.resume, follow?.toggle, registerFollow]);

  return follow?.isFollowing ?? true;
}
