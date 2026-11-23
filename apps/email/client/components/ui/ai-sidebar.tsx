import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import { useQueryState } from "nuqs";
import { Clock, SettingsGear, X } from "@/components/icons/icons";
import { AssistantIcon } from "@/components/icons/mail-icons";
import { Button } from "@/components/ui/button";
import { MailConversation } from "@/components/assistant/mail-conversation";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useTRPC } from "@/providers/query-provider";
import { useActiveConnection } from "@/hooks/use-connections";
import { useMediaQuery } from "@/hooks/use-media-query";

const AIContext = createContext<{ open: boolean; setOpen: (v: boolean) => void } | null>(null);

function restoreAssistantFocus() {
  const triggers = document.querySelectorAll<HTMLButtonElement>(
    '[data-mail-assistant-trigger], button[aria-label="Toggle Sidebar"]',
  );
  [...triggers].find((trigger) => trigger.getClientRects().length > 0)?.focus();
}

export function useAISidebar() {
  const ctx = useContext(AIContext);
  if (!ctx) throw new Error("AI sidebar provider is missing");
  return { ...ctx, toggleOpen: () => ctx.setOpen(!ctx.open) };
}

export function AISidebarProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false);
  const account = useActiveConnection();
  const desktop = useMediaQuery("(min-width: 1024px)");
  const setOpen = useCallback(
    (value: boolean) => {
      setOpenState(value);
      if (!value && desktop) requestAnimationFrame(restoreAssistantFocus);
    },
    [desktop],
  );
  return (
    <AIContext.Provider value={{ open, setOpen }}>
      {children}
      {open &&
        (desktop ? (
          <aside
            id="mail-assistant"
            aria-label="Mail assistant"
            className="bg-panelLight dark:bg-panelDark my-1 mr-1 h-[calc(100dvh-8px)] w-[360px] shrink-0 overflow-hidden rounded-2xl shadow-sm xl:w-[380px]"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.defaultPrevented) setOpen(false);
            }}
          >
            <AISidebar key={account.data?.id ?? "signed-out"} />
          </aside>
        ) : (
          <Sheet open onOpenChange={setOpen}>
            <SheetContent
              id="mail-assistant"
              onEscapeKeyDown={(event) => {
                if (event.target instanceof Element && event.target.closest("dialog[open]"))
                  event.preventDefault();
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                restoreAssistantFocus();
              }}
              className="bg-panelLight dark:bg-panelDark inset-y-2 right-2 flex h-[calc(100dvh-16px)] w-[calc(100%-16px)] flex-col overflow-hidden rounded-2xl border-none p-0 sm:max-w-[380px]"
            >
              <SheetTitle className="sr-only">Mail assistant</SheetTitle>
              <SheetDescription className="sr-only">
                Ask about your mail or draft a reply.
              </SheetDescription>
              <AISidebar key={account.data?.id ?? "signed-out"} />
            </SheetContent>
          </Sheet>
        ))}
    </AIContext.Provider>
  );
}

export default function AISidebar() {
  const { setOpen } = useAISidebar();
  const trpc = useTRPC();
  const { pathname } = useLocation();
  const [currentId] = useQueryState("threadId");
  const state = useQuery(trpc.assistant.state.queryOptions());
  const folder = pathname.startsWith("/mail/") ? pathname.split("/")[2] : null;
  return (
    <div className="flex h-full min-h-0 flex-col text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 px-4">
        <div className="flex items-center gap-2">
          <AssistantIcon className="size-4" />
          <h2 className="text-[13px] font-medium">Assistant</h2>
        </div>
        <div className="flex items-center gap-0.5">
          <Button asChild variant="ghost" size="icon" className="size-7">
            <Link
              to="/settings/agents"
              aria-label="Assistant settings"
              title="Assistant settings"
              onClick={() => setOpen(false)}
            >
              <SettingsGear className="size-4" />
            </Link>
          </Button>
          <Button
            autoFocus
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Close assistant"
            title="Close assistant"
            onClick={() => setOpen(false)}
          >
            <X className="size-4 fill-iconLight dark:fill-iconDark" />
          </Button>
        </div>
      </header>
      {state.isPending ? (
        <div
          className="flex flex-1 flex-col justify-center gap-3 px-6"
          role="status"
          aria-label="Loading assistant"
        >
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-56" />
          <Skeleton className="mt-4 h-32 w-full rounded-xl" />
        </div>
      ) : state.isError ? (
        <div className="flex flex-1 flex-col items-start justify-center gap-3 px-6">
          <p className="text-sm font-medium">Couldn’t load the assistant</p>
          <p role="alert" className="text-[13px] leading-relaxed text-muted-foreground">
            {state.error.message}
          </p>
          <Button variant="outline" size="sm" onClick={() => void state.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          {state.data.enabled ? (
            <MailConversation
              key={state.data.mailboxId}
              state={state.data}
              currentId={currentId}
              folder={folder ?? null}
            />
          ) : (
            <div className="flex flex-1 flex-col justify-center px-6 py-8">
              <AssistantIcon className="mb-4 size-6" />
              <h3 className="text-lg font-medium tracking-tight">A little help with your mail</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                Find a conversation, catch up, or start a reply.
              </p>
              <Button asChild variant="outline" size="sm" className="mt-5 w-fit">
                <Link to="/settings/agents" onClick={() => setOpen(false)}>
                  Connect AI
                </Link>
              </Button>
            </div>
          )}
          <div className="shrink-0 px-4 pb-3">
            <div className="mt-2.5 flex min-w-0 items-center justify-between gap-3 px-1 text-[11px] text-muted-foreground">
              <span className="truncate" title={state.data.email}>
                {state.data.email}
              </span>
              {state.data.enabled && (
                <Link
                  className="flex shrink-0 items-center gap-1.5 hover:text-foreground"
                  to="/mail/scheduled"
                  onClick={() => setOpen(false)}
                >
                  <Clock className="size-3" />
                  Review sends
                </Link>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
