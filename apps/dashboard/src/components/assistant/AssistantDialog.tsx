"use client";

import type { ComponentProps } from "react";
import { Icon } from "@repo/ui/icons";
import { Modal } from "@/components/ui/Modal";
import { useDialogFocus } from "@/hooks/useDialogFocus";

type Props = ComponentProps<typeof Modal> & { label: string };

/** Keep the shared modal surface and keyboard behavior together for assistant dialogs. */
export function AssistantDialog(props: Props) {
  return props.isOpen || props.keepMounted ? <OpenDialog {...props} /> : null;
}

function OpenDialog({
  label,
  children,
  footer,
  onClose,
  closable = true,
  isOpen,
  ...props
}: Props) {
  const close = () => {
    if (closable) onClose();
  };
  const { dialog, onKeyDown } = useDialogFocus(close, isOpen);
  return (
    <Modal {...props} isOpen={isOpen} onClose={close} closable={closable} showCloseButton={false}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative flex min-h-0 flex-1 flex-col outline-none"
      >
        <button
          type="button"
          aria-label={`Close ${label}`}
          disabled={!closable}
          onClick={close}
          className="absolute end-4 top-4 z-10 rounded-lg bg-card p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Icon name="close" className="size-5" />
        </button>
        {children}
        {footer}
      </div>
    </Modal>
  );
}
