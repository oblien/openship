"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { PromptPayload } from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { useModal } from "@/context/ModalContext";
import { getApiErrorMessage } from "@/lib/api/client";
import { PromptDetails } from "./PromptDetails";

function PromptContent({
  prompt,
  respond,
}: {
  prompt: PromptPayload;
  respond: (action: string) => Promise<void>;
}) {
  const submitting = useRef(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messageId = useId();

  const submit = async (id: string) => {
    if (submitting.current) return;
    submitting.current = true;
    setActionId(id);
    setError(null);
    try {
      // The owner clears the prompt only after the server accepts the answer.
      await respond(id);
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      submitting.current = false;
      setActionId(null);
    }
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={prompt.title}
      aria-describedby={messageId}
      aria-busy={actionId !== null}
      tabIndex={-1}
      className="space-y-5 p-6"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const buttons =
          event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (
          !first ||
          document.activeElement === event.currentTarget ||
          (event.shiftKey && document.activeElement === first) ||
          (!event.shiftKey && document.activeElement === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
          if (!first) event.currentTarget.focus();
        }
      }}
    >
      <div className="space-y-2">
        <h3 className="text-xl font-bold text-foreground">{prompt.title}</h3>
        <p id={messageId} className="text-sm leading-relaxed text-muted-foreground">
          {prompt.message}
        </p>
      </div>
      <PromptDetails details={prompt.details} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-3 pt-2">
        {prompt.actions.map((action, index) => (
          <Button
            key={action.id}
            type="button"
            variant={
              action.variant === "danger"
                ? "destructive"
                : action.variant === "primary"
                  ? "default"
                  : "secondary"
            }
            className="h-auto min-h-10 whitespace-normal max-sm:w-full"
            disabled={actionId !== null}
            autoFocus={index === 0}
            onClick={() => void submit(action.id)}
          >
            {actionId === action.id && (
              <Icon name="spinner" className="size-4 animate-spin" aria-hidden="true" />
            )}
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** One held deployment decision for both single-app and Compose build pages. */
export function useDeploymentPrompt(
  prompt: PromptPayload | null,
  respond: (action: string) => Promise<void>,
) {
  const { showModal, hideModal } = useModal();
  const respondRef = useRef(respond);
  respondRef.current = respond;

  useEffect(() => {
    if (!prompt) return;
    const previousFocus = document.activeElement;
    const modalId = showModal({
      title: prompt.title,
      icon: "warning",
      // Dismissing the window must not leave an invisible hold in the pipeline.
      closable: false,
      showCloseButton: false,
      customContent: (
        <PromptContent prompt={prompt} respond={(action) => respondRef.current(action)} />
      ),
      width: "560px",
      maxWidth: "92vw",
    });
    return () => {
      hideModal(modalId);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [prompt, showModal, hideModal]);
}
