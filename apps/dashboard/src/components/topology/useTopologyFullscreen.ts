"use client";

import { useLayoutEffect, useRef, type KeyboardEvent } from "react";

/** Expand the existing workspace in place, keeping canvas and editor state alive. */
export function useTopologyFullscreen(fullscreen: boolean) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!fullscreen || !workspace) return;

    // Isolate the page behind the workspace. Later body portals (menus and
    // deployment dialogs) stay usable above it, unlike native browser fullscreen.
    const siblings = new Map<HTMLElement, boolean>();
    let branch: HTMLElement = workspace;
    while (branch.parentElement && branch !== document.body) {
      for (const sibling of branch.parentElement.children) {
        if (sibling instanceof HTMLElement && sibling !== branch) {
          siblings.set(sibling, sibling.inert);
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
    }

    const scrollers = new Map<HTMLElement, string>();
    for (const scroller of [workspace.closest("main"), document.body]) {
      if (!scroller) continue;
      scrollers.set(scroller, scroller.style.overflow);
      scroller.style.overflow = "hidden";
    }
    if (!workspace.contains(document.activeElement)) {
      toggleRef.current?.focus({ preventScroll: true });
    }

    return () => {
      for (const [element, inert] of siblings) element.inert = inert;
      for (const [element, overflow] of scrollers) element.style.overflow = overflow;
      toggleRef.current?.focus({ preventScroll: true });
    };
  }, [fullscreen]);

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!fullscreen || event.key !== "Tab" || event.defaultPrevented) return;
    // Portalled dialogs and menus manage their own focus.
    if (!event.currentTarget.contains(event.target as Node)) return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.getClientRects().length > 0 && !element.closest("[inert]"));
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return { workspaceRef, toggleRef, trapFocus };
}
