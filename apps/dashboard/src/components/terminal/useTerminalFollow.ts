"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";

/** Keeps new output in view until the user scrolls away or pauses following. */
export function useTerminalFollow(terminal: Terminal | null) {
  const [isFollowing, setIsFollowing] = useState(true);
  const terminalRef = useRef(terminal);
  const isFollowingRef = useRef(true);
  const explicitlyPausedRef = useRef(false);
  const pausedViewportRef = useRef<number | null>(null);
  terminalRef.current = terminal;

  const updateFollowing = useCallback((following: boolean) => {
    isFollowingRef.current = following;
    setIsFollowing(following);
  }, []);

  useEffect(() => {
    explicitlyPausedRef.current = false;
    pausedViewportRef.current = null;
    updateFollowing(true);
    if (!terminal) return;

    const scrollSubscription = terminal.onScroll((position) => {
      const isAtBottom = position >= terminal.buffer.active.baseY;
      if (isAtBottom) {
        if (!explicitlyPausedRef.current) {
          pausedViewportRef.current = null;
          updateFollowing(true);
        }
      } else {
        pausedViewportRef.current = position;
        updateFollowing(false);
      }
    });
    const writeSubscription = terminal.onWriteParsed(() => {
      if (isFollowingRef.current) terminal.scrollToBottom();
      else if (pausedViewportRef.current !== null) {
        terminal.scrollToLine(Math.min(pausedViewportRef.current, terminal.buffer.active.baseY));
      }
    });
    const resizeSubscription = terminal.onResize(() => {
      if (isFollowingRef.current) terminal.scrollToBottom();
    });

    return () => {
      scrollSubscription.dispose();
      writeSubscription.dispose();
      resizeSubscription.dispose();
    };
  }, [terminal, updateFollowing]);

  const pause = useCallback(() => {
    const activeTerminal = terminalRef.current;
    explicitlyPausedRef.current = true;
    pausedViewportRef.current = activeTerminal?.buffer.active.viewportY ?? 0;
    updateFollowing(false);
  }, [updateFollowing]);

  const pauseForInspection = useCallback(() => {
    const activeTerminal = terminalRef.current;
    explicitlyPausedRef.current = false;
    pausedViewportRef.current = activeTerminal?.buffer.active.viewportY ?? 0;
    updateFollowing(false);
  }, [updateFollowing]);

  const resume = useCallback(() => {
    const activeTerminal = terminalRef.current;
    explicitlyPausedRef.current = false;
    pausedViewportRef.current = null;
    updateFollowing(true);
    activeTerminal?.scrollToBottom();
  }, [updateFollowing]);

  const toggle = useCallback(() => {
    if (isFollowingRef.current) pause();
    else resume();
  }, [pause, resume]);

  return { isFollowing, pause, pauseForInspection, resume, toggle };
}
