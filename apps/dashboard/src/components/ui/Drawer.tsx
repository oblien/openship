"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@repo/ui/icons";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { Button } from "./button";

/** An inset drawer. Nested dialogs and select portals stay above this layer. */
export function Drawer({
  isOpen,
  onClose,
  label,
  closeLabel = "Close panel",
  contentKey,
  width = "560px",
  children,
}: {
  isOpen: boolean;
  onClose(): void;
  label: string;
  closeLabel?: string;
  contentKey?: string;
  width?: string;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const [present, setPresent] = useState(false);
  const [visible, setVisible] = useState(false);
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setPresent(true);
    } else {
      setVisible(false);
      const timeout = setTimeout(() => setPresent(false), reducedMotion ? 0 : 220);
      return () => clearTimeout(timeout);
    }
  }, [isOpen, reducedMotion]);

  useEffect(() => {
    if (!present || !isOpen) return;
    let secondFrame: number;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setVisible(true));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [present, isOpen]);

  useEffect(() => {
    if (!present) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // The drawer is a body portal; disable only the page roots already behind it.
    // Later portals (select menus and nested dialogs) remain interactive.
    const behind = Array.from(document.body.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement &&
        element !== layer.current &&
        !element.matches("script, style, link, nextjs-portal, [data-modal-layer]"),
    );
    const previousInert = behind.map((element) => element.inert);
    behind.forEach((element) => (element.inert = true));
    return () => {
      document.body.style.overflow = previousOverflow;
      behind.forEach((element, index) => (element.inert = previousInert[index]));
    };
  }, [present]);

  // Restore page interactivity before returning focus to the opener on dismissal.
  const { dialog, onKeyDown } = useDialogFocus(onClose, present);
  useEffect(() => {
    dialog.current?.focus();
  }, [contentKey, dialog]);

  if (!present) return null;
  return createPortal(
    <div ref={layer} data-modal-layer="9000" className="fixed inset-0 z-[9000]">
      <div
        data-drawer-backdrop=""
        className="absolute inset-0 transition-opacity duration-200 motion-reduce:transition-none"
        style={{
          background: "color-mix(in oklab, var(--th-overlay) 65%, transparent)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          opacity: visible && isOpen ? 1 : 0,
        }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-drawer-panel=""
        className="absolute inset-y-2 right-2 flex max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-3xl bg-background shadow-2xl outline-none transition-[transform,opacity,width] duration-[220ms] ease-[cubic-bezier(0.2,0.9,0.3,1)] motion-reduce:transition-none sm:inset-y-4 sm:right-4 sm:max-w-[calc(100vw-2rem)]"
        style={{
          width,
          opacity: visible && isOpen ? 1 : 0,
          transform: visible && isOpen ? "translateX(0)" : "translateX(calc(100% + 1rem))",
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={closeLabel}
          onClick={onClose}
          className="absolute right-4 top-4 z-10 rounded-full"
        >
          <Icon name="close" />
        </Button>
        {children}
      </div>
    </div>,
    document.body,
  );
}
