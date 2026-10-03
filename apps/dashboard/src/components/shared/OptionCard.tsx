"use client";

import type { ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";

interface OptionCardProps {
  value: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  icon: ReactNode;
  label: string;
  description: ReactNode;
  badge?: ReactNode;
  /** Selected options can reveal related controls outside the button. */
  children?: ReactNode;
  className?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}

/** Shared surface for single-choice cards and multi-select service cards. */
export function optionCardSurface(selected: boolean) {
  return selected
    ? "border-primary bg-primary/5 ring-1 ring-primary/20"
    : "border-border/50 bg-card hover:border-primary/30 hover:bg-primary/[0.02]";
}

/** The shared bordered choice used for deployment destinations and settings. */
export function OptionCard({ value, selected, disabled = false, onSelect, icon, label, description, badge, children, className, buttonRef }: OptionCardProps) {
  return (
    <div className={className}>
      <button
        ref={buttonRef}
        type="button"
        value={value}
        aria-pressed={selected}
        onClick={onSelect}
        disabled={disabled}
        className={cn(
          "relative h-full w-full rounded-xl border p-4 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          optionCardSurface(selected),
          selected && children && "rounded-b-none border-b-0",
        )}
      >
        <div className="flex items-start gap-3">
          <div className={cn("shrink-0 rounded-lg p-2", selected ? "bg-primary/10 text-primary" : "bg-muted/50 text-muted-foreground")}>
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("text-sm font-semibold", selected ? "text-foreground" : "text-foreground/80")}>{label}</span>
              {badge}
            </div>
            <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</div>
          </div>
          {selected && (
            <span aria-hidden="true" className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary">
              <span className="size-2 rounded-full bg-primary-foreground" />
            </span>
          )}
        </div>
      </button>
      {selected && children && (
        <div className="rounded-b-xl border border-t-0 border-primary/20 bg-primary/[0.02] px-4 pb-4 pt-2">
          {children}
        </div>
      )}
    </div>
  );
}
