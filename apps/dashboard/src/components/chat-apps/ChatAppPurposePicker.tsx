"use client";
import type { ChatAppPurpose } from "@repo/contracts";
import { Icon, type IconName } from "@repo/ui/icons";
import { Checkbox } from "@/components/ui/Checkbox";
import { cn } from "@/lib/utils";

export const CHAT_PURPOSE_LABELS: Record<ChatAppPurpose, string> = {
  assistant: "Assistant",
  commands: "Control plane",
  both: "Assistant & control plane",
};
const choices: { purpose: "assistant" | "commands"; icon: IconName }[] = [
  { purpose: "assistant", icon: "assistant" },
  { purpose: "commands", icon: "terminal" },
];
export function ChatAppPurposePicker({
  value,
  onChange,
  disabled,
  stacked = false,
}: {
  value: ChatAppPurpose | null;
  onChange(value: ChatAppPurpose | null): void;
  disabled?: boolean;
  stacked?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-2 text-sm">Use this bot for</legend>
      <div className={cn("grid gap-2", stacked ? "grid-cols-1" : "grid-cols-2")}>
        {choices.map(({ purpose, icon }) => {
          const checked = value === purpose || value === "both";
          const other = purpose === "assistant" ? "commands" : "assistant";
          return (
            <button
              key={purpose}
              type="button"
              role="checkbox"
              aria-checked={checked}
              aria-label={CHAT_PURPOSE_LABELS[purpose]}
              disabled={disabled}
              onClick={() =>
                onChange(checked ? (value === "both" ? other : null) : value ? "both" : purpose)
              }
              className={cn(
                "flex h-11 items-center gap-2 rounded-xl px-3 text-start text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60",
                checked
                  ? "bg-muted text-foreground"
                  : "bg-background/60 text-muted-foreground hover:bg-muted/60",
              )}
            >
              <Icon
                name={icon}
                className={cn("size-4 shrink-0", checked && purpose === "assistant" && "text-info")}
              />
              <span className="flex-1 whitespace-nowrap">{CHAT_PURPOSE_LABELS[purpose]}</span>
              <Checkbox asButton={false} checked={checked} size="sm" />
            </button>
          );
        })}
      </div>
      {!value && (
        <p role="alert" className="mt-2 text-xs text-danger">
          Select at least one option.
        </p>
      )}
    </fieldset>
  );
}
