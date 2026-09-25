"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { forwardRef } from "react";

export interface CheckboxProps {
  /** Controlled checked state. */
  checked: boolean | "indeterminate";
  /** Change handler - receives the new boolean checked state. */
  onCheckedChange?: (checked: boolean) => void;
  /** Disabled state - non-interactive + dimmed. */
  disabled?: boolean;
  /** Size variant. "sm" = 14px, "md" = 16px (default), "lg" = 20px. */
  size?: "sm" | "md" | "lg";
  /** Color accent. Defaults to primary. */
  tone?: "primary" | "destructive";
  /** ARIA label when there's no adjacent <label>. */
  "aria-label"?: string;
  /** Optional className for the outer wrapper. */
  className?: string;
  /** Click-anywhere hit target - when wrapped in a <label> outside, leave this false. */
  asButton?: boolean;
  /** ID for label htmlFor association. */
  id?: string;
  /** Focus on mount. */
  autoFocus?: boolean;
  /** Click handler - fires before onCheckedChange. Use sparingly (mostly for stopPropagation in nested rows). */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

const SIZE_CLASSES = {
  sm: "size-3.5",
  md: "size-4",
  lg: "size-5",
} as const;

const ICON_SIZE = {
  sm: "size-2.5",
  md: "size-3",
  lg: "size-3.5",
} as const;

const TONE_ON = {
  primary: "bg-primary border-primary text-primary-foreground",
  destructive: "bg-danger-solid border-danger-solid text-white",
} as const;

/**
 * Custom checkbox replacing the browser default - the native control
 * doesn't honor design tokens and renders inconsistently across
 * Chrome/Safari/Firefox.
 *
 * Implemented as a <button role="checkbox"> so it's keyboard-focusable,
 * screen-reader-readable, and styleable from scratch. Pair with a
 * sibling <label htmlFor={id}> for full a11y when used outside a
 * compound row.
 *
 * Visuals: rounded square, animated check icon, primary or destructive
 * tone, ring on focus, dimmed when disabled. Supports indeterminate
 * (dash icon) for tri-state.
 */
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(
  function Checkbox(
    {
      checked,
      onCheckedChange,
      disabled,
      size = "md",
      tone = "primary",
      className,
      id,
      autoFocus,
      onClick,
      ...rest
    },
    ref,
  ) {
    const isOn = checked === true || checked === "indeterminate";
    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      if (disabled) return;
      onCheckedChange?.(!(checked === true));
    };

    return (
      <button
        ref={ref}
        id={id}
        type="button"
        role="checkbox"
        aria-checked={checked === "indeterminate" ? "mixed" : checked}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        autoFocus={autoFocus}
        onClick={handleClick}
        className={
          // Box (always renders): rounded square, animated borders + fill.
          // Off state: subtle muted border on transparent background, hover
          // lifts to a slight inset. On state: solid tone-fill + tone-border.
          // Focus: 2px ring in tone color. Disabled: 50% opacity, no hover.
          `relative inline-flex shrink-0 items-center justify-center rounded-[5px] border transition-all duration-150 ` +
          `outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ` +
          `disabled:cursor-not-allowed disabled:opacity-50 ` +
          SIZE_CLASSES[size] + " " +
          (isOn
            ? TONE_ON[tone]
            : "border-border/70 bg-transparent hover:border-foreground/40 hover:bg-foreground/[0.03]") +
          " " +
          (className ?? "")
        }
        {...rest}
      >
        {checked === "indeterminate" ? (
          <UiIcon name="minus" className={`${ICON_SIZE[size]} stroke-[3]`} aria-hidden="true" />
        ) : checked === true ? (
          <UiIcon name="check" className={`${ICON_SIZE[size]} stroke-[3]`} aria-hidden="true" />
        ) : null}
      </button>
    );
  },
);
