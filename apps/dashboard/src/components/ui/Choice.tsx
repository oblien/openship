"use client";

import { Checkbox } from "./Checkbox";

/**
 * A togglable row — one option in a multi-select list.
 *
 * The whole row is the hit target, not a 13px native checkbox, and the selected state is
 * carried by the row's border and tint as well as the box: on a dark theme a bare native
 * checkbox is the one control that renders in the browser's colours instead of the
 * product's, which is why a list of them looks pasted in from another application.
 *
 * Extracted from `JobForm`, where it lived as a local helper. It was already the pattern
 * for "pick several channels / servers / dependencies", so a second copy would have been
 * the thing that lets two lists of the same choice drift apart.
 */
export function Choice({
  checked,
  onToggle,
  label,
  hint,
  icon,
  disabled,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  /** Secondary text after the label — a kind, a host, a scope. */
  hint?: string;
  /** Leading visual: a channel's brand mark, a provider logo. Sits after the checkbox, so
   *  the selected state still reads down a single column in a list. */
  icon?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      // `aria-pressed`, not a checkbox role: this IS a button, and the Checkbox inside is
      // presentational (pointer-events off) so the row can never report two states.
      aria-pressed={checked}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-start text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "border-primary/50 bg-primary/5" : "border-border/50 hover:bg-muted/40"
      }`}
    >
      <Checkbox checked={checked} size="sm" className="pointer-events-none" />
      {icon && <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>}
      <span className="truncate text-foreground">{label}</span>
      {hint && <span className="shrink-0 text-xs text-muted-foreground">{hint}</span>}
    </button>
  );
}
