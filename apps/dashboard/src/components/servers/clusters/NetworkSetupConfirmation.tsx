"use client";

import { useId, type ReactNode } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";

export function NetworkSetupConfirmation({
  title,
  description,
  confirmLabel,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onClose(): void;
  onConfirm(): void;
}) {
  const id = useId();
  const { t } = useI18n();
  return (
    <Modal
      isOpen
      onClose={onClose}
      closable={!busy}
      showCloseButton={!busy}
      width="480px"
      maxWidth="94vw"
    >
      <div
        className="p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onClose();
        }}
      >
        <div className="mb-4 grid size-10 place-items-center rounded-xl bg-danger/10 text-danger">
          <Trash2 className="size-5" />
        </div>
        <h2 id={`${id}-title`} className="pe-6 text-lg font-semibold">
          {title}
        </h2>
        <p id={`${id}-description`} className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
        {error && (
          <p role="alert" className="mt-4 text-sm leading-relaxed text-danger">
            {error}
          </p>
        )}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button autoFocus variant="ghost" disabled={busy} onClick={onClose}>
            {t.servers.networks.cancel}
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={onConfirm}
            className="h-auto min-h-10 whitespace-normal"
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
