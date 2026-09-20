"use client";

/**
 * A two-up card picker for a setting that is a CHOICE between named modes, not a
 * feature you switch on.
 *
 * Product mode is the case this exists for. As a toggle it read wrong in both
 * directions: "off" isn't the absence of anything, it's the full platform — a
 * positive state with its own name — and the instance default and the per-user
 * override are the same question asked at two scopes, so they have to look like
 * the same control. Both `MailModeSetting` (instance) and `ProductViewSetting`
 * (per user) render this, which is what keeps them identical.
 */

import { Check } from "lucide-react";

type ChoiceIcon = React.ComponentType<{ className?: string; strokeWidth?: number }>;

export interface ModeChoice<V extends string> {
  value: V;
  icon: ChoiceIcon;
  label: string;
  description: string;
}

export function ModeChoiceCards<V extends string>({
  choices,
  value,
  onSelect,
  disabled = false,
}: {
  choices: Array<ModeChoice<V>>;
  value: V;
  /** Not called for the already-active card — picking what's picked is a no-op,
   *  not a save. */
  onSelect: (value: V) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {choices.map((choice) => {
        const active = choice.value === value;
        const Icon = choice.icon;
        return (
          <button
            key={choice.value}
            type="button"
            onClick={() => !active && !disabled && onSelect(choice.value)}
            aria-pressed={active}
            disabled={disabled}
            className={`group relative flex items-start gap-3 rounded-xl border p-4 text-start transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
              active
                ? "border-primary/50 bg-primary/[0.06] ring-1 ring-primary/25"
                : "border-border/50 bg-muted/10 hover:border-border hover:bg-muted/30"
            }`}
          >
            <div
              className={`flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors ${
                active
                  ? "bg-primary/15 text-primary"
                  : "bg-muted text-muted-foreground group-hover:text-foreground"
              }`}
            >
              <Icon className="size-[18px]" strokeWidth={1.8} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{choice.label}</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
                {choice.description}
              </p>
            </div>
            {active && (
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Check className="size-3.5" strokeWidth={2.5} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
