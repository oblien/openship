"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface TerminalSearchProps {
  value: string;
  onChange: (value: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  hasMatches: boolean;
  searching: boolean;
  disabled?: boolean;
}

/** The same filled search field and match navigation in project and deployment logs. */
export function TerminalSearch({ value, onChange, onNext, onPrevious, hasMatches, searching, disabled }: TerminalSearchProps) {
  const { t } = useI18n();
  const copy = t.projectDetail.logs;
  const canNavigate = !disabled && hasMatches && !searching;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <UiIcon name="search" aria-hidden className="absolute start-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
        <Input
          type="text"
          variant="filled"
          placeholder={copy.terminal.searchPlaceholder}
          aria-label={copy.terminal.searchPlaceholder}
          aria-busy={searching}
          value={value}
          disabled={disabled}
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (canNavigate) {
                if (event.shiftKey) onPrevious();
                else onNext();
              }
            } else if (event.key === "Escape") {
              event.preventDefault();
              onChange("");
            }
          }}
          className="h-9 ps-9 pe-9"
        />
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onChange("")}
            aria-label={copy.actions.clear}
            className="absolute end-1 top-1/2 size-7 -translate-y-1/2 rounded-lg"
          >
            <UiIcon name="close" aria-hidden className="size-3.5" />
          </Button>
        )}
      </div>
      {value && (
        <div className="flex items-center gap-1">
          <Button type="button" variant="secondary" size="icon" onClick={onPrevious} disabled={!canNavigate} title={copy.terminal.previousMatch} aria-label={copy.terminal.previousMatch}>
            <UiIcon name="chevron-up" aria-hidden className="size-3.5" />
          </Button>
          <Button type="button" variant="secondary" size="icon" onClick={onNext} disabled={!canNavigate} title={copy.terminal.nextMatch} aria-label={copy.terminal.nextMatch}>
            <UiIcon name="chevron-down" aria-hidden className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
