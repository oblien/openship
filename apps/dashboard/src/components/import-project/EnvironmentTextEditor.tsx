"use client";

import { useId, useState } from "react";
import { Icon as UiIcon } from "@repo/ui/icons";
import { EnvFileSyntaxError } from "@repo/core";
import { Modal } from "@/components/ui/Modal";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { environmentFromText, environmentToText } from "@/lib/environment-text";
import type { EnvironmentVariableRow } from "./types";

type Props = {
  rows: EnvironmentVariableRow[];
  onChange: (rows: EnvironmentVariableRow[]) => void;
  readOnlyKeys?: string[];
  disabled?: boolean;
  className?: string;
};

/** The draft is isolated until Apply, so host Save/Deploy actions cannot submit partial text. */
export function EnvironmentTextEditor(props: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={props.disabled}
        className={props.className}
      >
        <UiIcon name="file-text" className="size-3.5" />
        {t.importProject.environmentVariables.textEditor.edit}
      </button>
      {open && <TextDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function TextDialog({
  rows,
  onChange,
  readOnlyKeys,
  disabled,
  onClose,
}: Props & { onClose: () => void }) {
  const { t } = useI18n();
  const ev = t.importProject.environmentVariables;
  const copy = ev.textEditor;
  const id = useId();
  const [snapshot] = useState(rows);
  const [initial] = useState(() => {
    try {
      return { text: environmentToText(rows), valid: true };
    } catch {
      // diagnostics-ignore: Invalid row names/duplicates are shown as form validation.
      return { text: "", valid: false };
    }
  });
  const [text, setText] = useState(initial.text);
  const [error, setError] = useState<string | null>(initial.valid ? null : copy.invalidRows);
  const apply = () => {
    if (disabled || !initial.valid) return;
    if (JSON.stringify(snapshot) !== JSON.stringify(rows)) {
      setError(copy.stale);
      return;
    }
    let next: EnvironmentVariableRow[];
    try {
      next = environmentFromText(text, snapshot, readOnlyKeys);
    } catch (cause) {
      // diagnostics-ignore: User-entered text is validated without logging environment values.
      setError(
        cause instanceof EnvFileSyntaxError
          ? interpolate(copy.invalidLine, { line: String(cause.line) })
          : copy.invalid,
      );
      return;
    }
    onChange(next);
    onClose();
  };
  return (
    <Modal
      isOpen
      onClose={onClose}
      maxWidth="820px"
      width="94vw"
      zIndex={10020}
      footer={
        <div className="flex flex-wrap justify-end gap-2 border-t border-border/50 px-6 py-4">
          <Button variant="ghost" onClick={onClose}>
            {ev.cancel}
          </Button>
          <Button onClick={apply} disabled={disabled || !initial.valid}>
            {copy.apply}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-6">
        <div className="pe-8">
          <h3 className="text-base font-semibold text-foreground">{copy.title}</h3>
          <p id={`${id}-help`} className="mt-2 text-sm text-muted-foreground">
            {copy.hint}
          </p>
        </div>
        <Textarea
          autoFocus
          dir="ltr"
          aria-label={copy.title}
          aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
          aria-invalid={Boolean(error)}
          variant="filled"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          disabled={disabled || !initial.valid}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          rows={14}
          className="min-h-64 max-h-[55vh] font-mono text-sm leading-6"
        />
        <p className="text-xs text-muted-foreground">{copy.savedValues}</p>
        {error && (
          <p id={`${id}-error`} role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
