"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { isImageUrl, MAX_IMAGE_URL_LENGTH } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useImageFallback } from "@/hooks/useImageFallback";
import { getApiErrorMessage } from "@/lib/api/client";

/** Shared URL editor; saving never depends on a remote image probe. */
export function ImageUrlEditor({
  value,
  editLabel,
  label,
  hint,
  resetLabel,
  fallback,
  onSave,
  onClose,
}: {
  value: string | null | undefined;
  editLabel: string;
  label: string;
  hint: string;
  resetLabel: string;
  fallback: ReactNode;
  onSave: (url: string | null) => Promise<void>;
  /** Open directly in a dialog instead of showing the inline Change action. */
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const c = t.settings.imageUrl;
  const id = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const wasEditing = useRef(false);
  const [editing, setEditing] = useState(!!onClose);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const close = () => {
    if (!saving) onClose?.();
  };
  const { dialog, onKeyDown } = useDialogFocus(close, !!onClose);
  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);
  useEffect(() => {
    if (editing) input.current?.focus();
    else if (wasEditing.current) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const trimmed = draft.trim();
  const preview = useImageFallback(isImageUrl(trimmed) ? trimmed : null);
  const cancel = () => {
    if (saving) return;
    setDraft(value ?? "");
    setError("");
    setSaved(false);
    setEditing(false);
    onClose?.();
  };
  const save = async (next: string | null) => {
    if (saving) return;
    if (next && !isImageUrl(next)) {
      setError(c.invalid);
      return;
    }
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await onSave(next);
      setDraft(next ?? "");
      setSaved(true);
      setEditing(false);
      onClose?.();
    } catch (failure) {
      setError(getApiErrorMessage(failure, c.failed));
    } finally {
      setSaving(false);
    }
  };
  const editor = (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div
          className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted/50 text-sm font-medium text-muted-foreground"
          role="img"
          aria-label={c.preview}
        >
          {preview.showImage ? (
            <img
              ref={preview.ref}
              src={trimmed}
              alt=""
              referrerPolicy="no-referrer"
              onError={preview.onError}
              className="size-full object-contain"
            />
          ) : (
            fallback
          )}
        </div>
        {editing ? (
          <label htmlFor={id} className="min-w-0 text-sm font-medium text-foreground">
            {label}
          </label>
        ) : (
          <button
            ref={editButton}
            type="button"
            onClick={() => {
              setSaved(false);
              setEditing(true);
            }}
            className="rounded-md px-1 py-1.5 text-sm text-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {editLabel}
          </button>
        )}
        {saved && (
          <span role="status" className="text-xs text-foreground/70">
            {c.saved}
          </span>
        )}
      </div>
      {editing && (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save(trimmed || null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !saving) {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
          }}
          className="space-y-3"
        >
          <Input
            ref={input}
            id={id}
            variant="filled"
            type="url"
            value={draft}
            placeholder="https://example.com/image.png"
            maxLength={MAX_IMAGE_URL_LENGTH}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            dir="ltr"
            disabled={saving}
            aria-invalid={!!error}
            aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
            onChange={(event) => {
              setDraft(event.target.value);
              setError("");
              setSaved(false);
            }}
          />
          <p id={`${id}-hint`} className="text-xs text-foreground/70">
            {hint}
          </p>
          {isImageUrl(trimmed) && !preview.showImage && (
            <p className="text-xs text-foreground/70">{c.previewFailed}</p>
          )}
          {error && (
            <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {value && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void save(null)}
                className="rounded-md py-1.5 text-xs text-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
              >
                {resetLabel}
              </button>
            )}
            <div className="ms-auto flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={cancel}>
                {t.settings.common.cancel}
              </Button>
              <Button type="submit" size="sm" disabled={saving || trimmed === (value ?? "")}>
                {saving ? c.saving : c.save}
              </Button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
  if (!onClose) return editor;
  return (
    <Modal
      isOpen
      onClose={close}
      closable={!saving}
      showCloseButton={false}
      width="28rem"
      maxWidth="calc(100vw - 2rem)"
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="space-y-5 p-6 outline-none"
      >
        <h2 id={`${id}-title`} className="text-base font-semibold text-foreground">
          {editLabel}
        </h2>
        {editor}
      </div>
    </Modal>
  );
}
