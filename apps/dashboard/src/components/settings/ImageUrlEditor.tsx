"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { isImageUrl, MAX_IMAGE_URL_LENGTH } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { Input } from "@/components/ui/input";
import { useImageFallback } from "@/hooks/useImageFallback";
import { getApiErrorMessage } from "@/lib/api/client";

/** Shared URL editor; saving never depends on a remote image probe. */
export function ImageUrlEditor({
  value,
  label,
  hint,
  resetLabel,
  fallback,
  onSave,
}: {
  value: string | null | undefined;
  label: string;
  hint: string;
  resetLabel: string;
  fallback: ReactNode;
  onSave: (url: string | null) => Promise<void>;
}) {
  const { t } = useI18n();
  const c = t.settings.imageUrl;
  const id = useId();
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);
  const trimmed = draft.trim();
  const preview = useImageFallback(isImageUrl(trimmed) ? trimmed : null);
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
    } catch (failure) {
      setError(getApiErrorMessage(failure, c.failed));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save(trimmed || null);
      }}
      className="space-y-3"
    >
      <div className="flex items-start gap-4">
        <div
          className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted/50 text-xl font-medium text-muted-foreground"
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
        <div className="min-w-0 flex-1 space-y-1.5">
          <label htmlFor={id} className="block text-sm font-medium text-foreground">
            {label}
          </label>
          <Input
            id={id}
            variant="filled"
            type="url"
            value={draft}
            placeholder="https://example.com/image.png"
            maxLength={MAX_IMAGE_URL_LENGTH}
            disabled={saving}
            aria-invalid={!!error}
            aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
            onChange={(event) => {
              setDraft(event.target.value);
              setError("");
              setSaved(false);
            }}
          />
        </div>
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
      {isImageUrl(trimmed) && !preview.showImage && (
        <p className="text-xs text-muted-foreground">{c.previewFailed}</p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={saving || trimmed === (value ?? "")}
          className="rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-40"
        >
          {saving ? c.saving : c.save}
        </button>
        {value && (
          <button
            type="button"
            disabled={saving}
            onClick={() => void save(null)}
            className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            {resetLabel}
          </button>
        )}
        {saved && (
          <span role="status" className="text-xs text-muted-foreground">
            {c.saved}
          </span>
        )}
      </div>
    </form>
  );
}
