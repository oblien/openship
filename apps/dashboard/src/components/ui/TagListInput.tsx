"use client";

import { X } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";

/**
 * Structured editors for the two shapes of `string[]` list fields the service
 * forms need — replacing freeform textareas that split on newline/comma:
 *
 *   • TagListInput   — free-entry chips (ports, volumes). Type a value and press
 *                      Enter or comma to commit it as a removable pill.
 *   • ChipMultiSelect — constrained multi-select (depends-on): toggle chips from
 *                      a fixed set of options (sibling service names).
 *
 * Both are controlled and emit plain string[] so callers keep byte-identical
 * submit payloads. TagListInput deliberately keeps its draft in the PARENT
 * (`draft`/`onDraftChange`) rather than internal state: the parent can fold any
 * uncommitted draft into the array at submit time, so text typed but not yet
 * Entered is never lost to the blur→setState→submit race.
 */

const splitDraft = (value: string) =>
  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

export function TagListInput({
  tags,
  draft,
  onTagsChange,
  onDraftChange,
  placeholder,
  maxItems,
  maxLength,
  ariaLabel,
  removeLabel,
}: {
  tags: string[];
  draft: string;
  onTagsChange: (next: string[]) => void;
  onDraftChange: (next: string) => void;
  placeholder?: string;
  maxItems?: number;
  maxLength?: number;
  ariaLabel?: string;
  removeLabel: string;
}) {
  const atCap = maxItems != null && tags.length >= maxItems;

  /** Fold the draft into the chip list, mirroring the old splitList (split on
   *  newline/comma, trim, drop empties) so pasted "a,b" still yields two chips. */
  const commit = () => {
    const pieces = splitDraft(draft);
    if (pieces.length === 0) {
      if (draft) onDraftChange("");
      return;
    }
    let next = tags;
    for (const piece of pieces) {
      if (maxItems != null && next.length >= maxItems) break;
      next = [...next, maxLength != null ? piece.slice(0, maxLength) : piece];
    }
    onTagsChange(next);
    onDraftChange("");
  };

  return (
    <div className="flex min-h-11 w-full flex-wrap items-center gap-1.5 rounded-xl border border-border/50 bg-muted/20 px-2 py-1.5 transition-colors focus-within:border-primary/40">
      {tags.map((tag, index) => (
        <span
          key={`${tag}-${index}`}
          className="inline-flex max-w-full items-center gap-1 rounded-lg bg-foreground/[0.06] py-1 pl-2.5 pr-1.5 font-mono text-[13px] text-foreground"
        >
          <span className="truncate">{tag}</span>
          <button
            type="button"
            onClick={() => onTagsChange(tags.filter((_, i) => i !== index))}
            aria-label={removeLabel}
            className="shrink-0 rounded-sm text-muted-foreground/50 transition-colors hover:text-danger"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(event) =>
          onDraftChange(maxLength != null ? event.target.value.slice(0, maxLength) : event.target.value)
        }
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            commit();
          } else if (event.key === "Backspace" && draft === "" && tags.length > 0) {
            onTagsChange(tags.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={tags.length === 0 ? placeholder : ""}
        aria-label={ariaLabel}
        disabled={atCap}
        className="min-w-[8ch] flex-1 bg-transparent px-1 py-1 font-mono text-sm text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground/50 disabled:cursor-not-allowed"
      />
    </div>
  );
}

export function ChipMultiSelect({
  value,
  options,
  onChange,
  emptyLabel,
}: {
  value: string[];
  options: string[];
  onChange: (next: string[]) => void;
  emptyLabel: string;
}) {
  // Surface any selected value that is no longer an option (a sibling that was
  // renamed or removed) so saving never silently drops a dependency the user
  // never touched — it stays visible and de-selectable.
  const all = [...options, ...value.filter((v) => !options.includes(v))];

  if (all.length === 0) {
    return <p className="text-xs text-muted-foreground/70">{emptyLabel}</p>;
  }

  const toggle = (name: string) =>
    onChange(value.includes(name) ? value.filter((v) => v !== name) : [...value, name]);

  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      {all.map((name) => {
        const checked = value.includes(name);
        return (
          <button
            key={name}
            type="button"
            onClick={() => toggle(name)}
            aria-pressed={checked}
            className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-start text-sm transition-colors ${
              checked ? "border-primary/50 bg-primary/5" : "border-border/50 hover:bg-muted/40"
            }`}
          >
            <Checkbox checked={checked} size="sm" className="pointer-events-none" />
            <span className="truncate font-mono text-[13px] text-foreground">{name}</span>
          </button>
        );
      })}
    </div>
  );
}
