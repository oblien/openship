"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { AssistantAgentIcon } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { cn } from "@/lib/utils";
import { BotAvatarArtwork } from "./BotAvatarArtwork";
import { AGENT_AVATAR_CHOICES, resolveAgentAvatar } from "./agent-avatar";

export function AgentAvatar({
  icon,
  agentId,
  className,
}: {
  icon?: string;
  agentId?: string;
  className?: string;
}) {
  const name = resolveAgentAvatar(icon, agentId);
  return (
    <span className={cn("inline-flex size-12 shrink-0 items-center justify-center", className)}>
      <BotAvatarArtwork id={name} />
    </span>
  );
}

export function AgentIconPicker({
  value,
  onChange,
}: {
  value: AssistantAgentIcon;
  onChange(value: AssistantAgentIcon): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return (
    <div
      ref={root}
      className="relative shrink-0"
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label="Choose bot avatar"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="group relative rounded-2xl transition-colors hover:bg-muted/50 focus-visible:bg-muted focus-visible:outline-none"
      >
        <AgentAvatar icon={value} className="size-16" />
        <span className="absolute -bottom-1 -right-1 rounded-full bg-secondary p-1.5 text-foreground">
          <Icon name="edit" className="size-3" />
        </span>
      </button>
      {open && (
        <div
          id={id}
          className="absolute start-0 top-full z-20 mt-3 w-80 max-w-[calc(100vw-4rem)] rounded-2xl bg-[var(--th-card-bg-solid)] p-3 shadow-xl"
        >
          <p className="px-2 pb-3 pt-1 text-sm font-medium">Choose a character</p>
          <div role="group" aria-label="Bot avatars" className="grid grid-cols-4 gap-1">
            {AGENT_AVATAR_CHOICES.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-label={item.label}
                title={item.label}
                aria-pressed={item.id === value}
                className={cn(
                  "relative flex flex-col items-center gap-1 rounded-xl px-1 pb-2 pt-2 transition-colors focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none",
                  item.id === value
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
                onClick={() => {
                  onChange(item.id);
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                <AgentAvatar icon={item.id} className="size-11" />
                <span className="text-[11px] leading-4">{item.label}</span>
                {item.id === value && (
                  <span className="absolute end-1.5 top-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Icon name="check" className="size-2.5" />
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
