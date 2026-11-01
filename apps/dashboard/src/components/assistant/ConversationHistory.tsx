"use client";

import { useState } from "react";
import {
  ASSISTANT_PROVIDER_LABELS,
  isAssistantActive,
  type AssistantConversation,
} from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AssistantListSkeleton } from "./AssistantSkeletons";

export function ConversationHistory({
  chats,
  selected,
  loading,
  error,
  busy,
  onSelect,
  onDelete,
  onRetry,
}: {
  chats: AssistantConversation[];
  selected: string | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onSelect(id: string): void;
  onDelete(chat: AssistantConversation): void;
  onRetry(): void;
}) {
  const [query, setQuery] = useState("");
  const matches = chats.filter((chat) =>
    chat.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const groups = new Map<string, AssistantConversation[]>();
  for (const chat of [...matches].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const date = new Date(chat.updatedAt);
    const label =
      date.toDateString() === today.toDateString()
        ? "Today"
        : date.toDateString() === yesterday.toDateString()
          ? "Yesterday"
          : Number.isNaN(date.getTime())
            ? "Earlier"
            : date.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}),
              });
    groups.set(label, [...(groups.get(label) ?? []), chat]);
  }
  if (error)
    return (
      <div role="alert" className="px-3 py-4 text-sm">
        <p className="text-danger">{error}</p>
        <Button variant="ghost" size="sm" onClick={onRetry} className="mt-2">
          Try again
        </Button>
      </div>
    );
  if (!chats.length && loading) return <AssistantListSkeleton label="Loading conversations" />;
  if (!chats.length)
    return (
      <div className="px-3 py-6 text-sm text-muted-foreground">
        <>
          <Icon name="message" className="mb-3 size-6 opacity-60" />
          <p className="font-medium text-foreground">Room for your next idea</p>
          <p className="mt-1 leading-6">
            Your conversations will appear here, ready to pick up where you left off.
          </p>
        </>
      </div>
    );
  return (
    <>
      <div className="relative mx-2 mb-3 shrink-0">
        <Icon
          name="search"
          className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          variant="filled"
          aria-label="Search conversations"
          placeholder="Search conversations…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-10 bg-card ps-9 pe-9"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            className="absolute end-1 top-1 flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
            onClick={() => setQuery("")}
          >
            <Icon name="close" className="size-3.5" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {!matches.length && (
          <p role="status" className="px-3 py-6 text-sm text-muted-foreground">
            No matching conversations.
          </p>
        )}
        {[...groups].map(([label, entries]) => (
          <section key={label} aria-label={label} className="mb-4">
            <h3 className="px-3 pb-2 pt-3 text-[11px] font-medium text-muted-foreground">
              {label}
            </h3>
            <ul className="space-y-0.5">
              {entries.map((chat) => (
                <li
                  key={chat.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-xl px-2 transition-colors hover:bg-muted/60",
                    selected === chat.id && "bg-muted/60",
                  )}
                >
                  <button
                    type="button"
                    aria-current={selected === chat.id ? "page" : undefined}
                    onClick={() => onSelect(chat.id)}
                    title={chat.title}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1 py-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <span
                      className="shrink-0 text-muted-foreground"
                      title={ASSISTANT_PROVIDER_LABELS[chat.provider]}
                    >
                      <Icon name={chat.provider} className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {chat.title}
                    </span>
                    {isAssistantActive(chat.state) && (
                      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="size-1.5 rounded-full bg-info motion-safe:animate-pulse" />
                        Running
                      </span>
                    )}
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${chat.title}`}
                    disabled={busy}
                    className="size-7 shrink-0 opacity-60 hover:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-60"
                    onClick={() => onDelete(chat)}
                  >
                    <Icon name="trash" className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
