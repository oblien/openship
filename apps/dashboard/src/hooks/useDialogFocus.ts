"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";

/** Keyboard behavior for custom content mounted inside the shared Modal. */
export function useDialogFocus(onClose: () => void, enabled = true) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!enabled) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    // Shared Modal mounts its portal after this effect. A single animation
    // frame can run before that commit and leave focus behind the backdrop.
    // Observe only until the ref is attached, then release the observer.
    let observer: MutationObserver | undefined;
    if (dialog.current) dialog.current.focus();
    else {
      observer = new MutationObserver(() => {
        if (!dialog.current) return;
        observer?.disconnect();
        dialog.current.focus();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    return () => {
      observer?.disconnect();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [enabled]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      // Let an open picker handle Escape first, including when its menu is
      // portaled outside the dialog. A second Escape closes this dialog.
      if (dialog.current?.querySelector('[aria-haspopup][aria-expanded="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]',
      ) ?? [],
    ).filter((element) => !element.closest("[hidden], [inert]"));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first) {
      event.preventDefault();
    } else if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === dialog.current)
    ) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  return { dialog, onKeyDown };
}
