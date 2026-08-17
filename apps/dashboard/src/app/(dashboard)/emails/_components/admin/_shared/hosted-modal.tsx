"use client";

/**
 * Bridge for mail-admin modals that are driven by a rendered `open` prop rather
 * than an imperative call, so they still get the dashboard's ONE modal shell
 * (`useModal` → `components/ui/Modal`: theme scrim, blur, glass surface, ESC,
 * z-index stacking) instead of a hand-rolled `fixed inset-0` overlay.
 *
 * `content` is rendered ONCE per open, so the returned element must own all of
 * its own state — later prop changes on the caller do not re-render it.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { useModal } from "@/context/ModalContext";

export function useHostedModal({
  open,
  onClose,
  content,
  maxWidth = "520px",
  closable = true,
  showCloseButton = false,
}: {
  open: boolean;
  /** Called when the shell closes itself (backdrop / ESC / its close button). */
  onClose: () => void;
  content: () => ReactNode;
  maxWidth?: string;
  /** false → backdrop and ESC cannot dismiss (in-flight destructive runs). */
  closable?: boolean;
  showCloseButton?: boolean;
}) {
  const { showModal, hideModal } = useModal();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const contentRef = useRef(content);
  contentRef.current = content;

  useEffect(() => {
    if (!open) return;
    // We closed it ourselves (the caller already knows) — don't call back and
    // re-enter the caller's close handler.
    let selfClosed = false;
    const id = showModal({
      maxWidth,
      closable,
      showCloseButton,
      onClose: () => {
        if (!selfClosed) onCloseRef.current();
      },
      customContent: contentRef.current(),
    });
    return () => {
      selfClosed = true;
      hideModal(id);
    };
    // Re-showing on config changes would remount the content and drop its state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
