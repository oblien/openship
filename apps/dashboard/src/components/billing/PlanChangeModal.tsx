"use client";

import { useId, type ReactNode } from "react";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { useDialogFocus } from "@/hooks/useDialogFocus";

/** Shared dialog chrome; each product keeps its existing quote and confirmation flow. */
export function PlanChangeModal({
  children,
  busy = false,
  width = 920,
  onClose,
  title,
}: {
  children: ReactNode;
  busy?: boolean;
  width?: number;
  onClose: () => void;
  title?: string;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const close = () => {
    if (!busy) onClose();
  };
  const { dialog, onKeyDown } = useDialogFocus(close);
  return (
    <Modal
      isOpen
      onClose={close}
      closable={!busy}
      showCloseButton={false}
      width={`min(${width}px, calc(100vw - 2rem))`}
      maxWidth="calc(100vw - 2rem)"
      maxHeight="calc(100dvh - 2rem)"
    >
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="min-h-0 overflow-auto p-5 sm:p-6"
      >
        <header className="mb-6 flex items-center justify-between gap-4">
          <h2 id={titleId} className="text-lg font-medium">
            {title ?? t.billing.workspaces.changePlan}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            onClick={close}
            aria-label={t.billing.deployGate.close}
          >
            <Icon name="close" className="size-4" />
          </Button>
        </header>
        {children}
      </section>
    </Modal>
  );
}
