import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import {
  ChatCore,
  ChatInputDefault,
  ChatProvider,
  useChatContext,
  type ChatApiHandler,
  type ChatMessage,
  type SendMessageParams,
  type ToolActivityConfig,
} from "@mindwire-ai/client";
import { normalizeMindwireMessages } from "@mindwire-ai/client/mindwire";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@zero/server/trpc";
import { useTRPC, useTRPCClient } from "@/providers/query-provider";
import { AssistantIcon } from "@/components/icons/mail-icons";
import { Mail, Search, Inbox, PencilCompose } from "@/components/icons/icons";
import { Button } from "@/components/ui/button";

type State = inferRouterOutputs<AppRouter>["assistant"]["state"];
type Message = State["messages"][number];
const markdownComponents = { img: () => null };
const toolLabels: Record<string, string> = {
  mail_search: "Search mail",
  mail_read: "Read mail",
  mail_save_draft: "Save draft",
  mail_prepare_send: "Prepare a send",
};
const tools: ToolActivityConfig = {
  mode: "inline",
  describeTool: (call) => ({
    label: toolLabels[call.name] ?? "Mail activity",
    icon: <Mail className="size-3.5 fill-current" />,
  }),
  renderDetails: ({ call }) => (
    <p className="text-sm text-muted-foreground">
      {call.status === "running"
        ? "Working with your mail…"
        : call.status === "failed"
          ? "This mail action could not be completed."
          : `${toolLabels[call.name] ?? "Mail action"} completed.`}
    </p>
  ),
};
const sourceRow = (message: Message): ChatMessage => ({
  messageId: `${message.id}:sources`,
  sender: "ai",
  type: "status",
  action: "mail.sources",
  finalized: true,
  isFinished: true,
  metadata: { sources: message.sources },
});

function MailSources(props: unknown) {
  const message = (props as { message: ChatMessage }).message;
  const sources = message.metadata?.sources as Message["sources"] | undefined;
  return (
    <div className="flex flex-col gap-1.5">
      {sources?.map((source) => (
        <Link
          key={`${source.folder}:${source.id}`}
          className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          to={`/mail/${encodeURIComponent(source.folder)}?threadId=${encodeURIComponent(source.id)}`}
        >
          <Mail className="size-3.5 shrink-0 fill-current" />
          <span className="truncate">{source.subject || "(No subject)"}</span>
        </Link>
      ))}
    </div>
  );
}
const statusComponents = { "mail.sources": MailSources };
const suggestions = [
  { icon: Inbox, label: "Catch up on unread mail", prompt: "Summarize my unread mail" },
  { icon: Search, label: "Find a conversation", prompt: "Help me find messages that need a reply" },
  { icon: PencilCompose, label: "Draft a reply", prompt: "Help me draft a reply" },
];

export function MailConversation({
  state,
  currentId,
  folder,
}: {
  state: State;
  currentId: string | null;
  folder: string | null;
}) {
  const client = useTRPCClient();
  const trpc = useTRPC();
  const cache = useQueryClient();
  const [context, setContext] = useState<{ id: string; folder: string } | null>(null);
  const includeThread = !!context && context.id === currentId && context.folder === folder;
  const current = useRef({ state, context: includeThread ? context : null });
  current.current = { state, context: includeThread ? context : null };
  const adapter = useMemo<ChatApiHandler>(() => {
    let controller: AbortController | undefined;
    let requestId: string | undefined;
    const mailboxId = state.mailboxId;
    return {
      supportsLive: false,
      async getHistory() {
        const snapshot = current.current.state;
        if (snapshot.mailboxId !== mailboxId) throw new Error("The selected mailbox has changed.");
        return {
          has_more: false,
          history: snapshot.messages.flatMap((message) => [
            ...normalizeMindwireMessages([
              {
                ...message,
                chatId: mailboxId,
                createdAt: "",
                parts:
                  message.role === "assistant"
                    ? [
                        ...(message.tools ?? []).map((tool) => ({
                          type: "tool",
                          tool: {
                            id: tool.id,
                            name: tool.name,
                            status: tool.state,
                            isError: tool.state === "failed",
                          },
                        })),
                        { type: "text", text: message.text },
                      ]
                    : undefined,
              },
            ]),
            ...(message.sources.length ? [sourceRow(message)] : []),
          ]),
        };
      },
      async sendMessage(params, emit) {
        if (!emit) throw new Error("Streaming is required.");
        const input = params as SendMessageParams;
        const prompt = input.message?.trim();
        if (!prompt) throw new Error("Write a message first.");
        controller?.abort();
        const reader = new AbortController();
        controller = reader;
        requestId = undefined;
        const wire = (event: string, data: Record<string, unknown>) => {
          if (!reader.signal.aborted) emit(JSON.stringify({ event, data }) + "\n");
        };
        let completed = false;
        try {
          const stream = await client.assistant.stream.mutate(
            { mailboxId, prompt, context: current.current.context ?? undefined },
            { signal: reader.signal },
          );
          for await (const event of stream) {
            if (reader.signal.aborted) return { status: true };
            if (event.type === "started") requestId = event.requestId;
            else if (event.type === "text")
              wire("ai_response", {
                messageId: `mail:${requestId}`,
                content: event.text,
                replace: true,
                stableId: true,
              });
            else if (event.type === "tool")
              wire("status_update", {
                messageId: `mail:${requestId}`,
                taskId: event.tool.id,
                kind: "tool",
                name: event.tool.name,
                state:
                  event.tool.state === "running"
                    ? "started"
                    : event.tool.state === "failed"
                      ? "failed"
                      : "finished",
                metadata: { args: null, content: null },
              });
            else if (event.type === "done") {
              wire("ai_response", {
                messageId: `mail:${requestId}`,
                content: event.message.text,
                replace: true,
                stableId: true,
              });
              if (event.message.sources.length)
                wire("status_update", {
                  messageId: `mail:${requestId}`,
                  taskId: `${requestId}:sources`,
                  eventType: "mail.sources",
                  kind: "mail",
                  name: "sources",
                  state: "finished",
                  metadata: { sources: event.message.sources },
                });
              completed = true;
              wire("ai_response_end", { status: "end" });
              void cache.invalidateQueries({ queryKey: trpc.assistant.pathKey() });
              void cache.invalidateQueries({ queryKey: trpc.outbox.pathKey() });
            }
          }
          if (!completed && !reader.signal.aborted)
            throw new Error("The connection ended before the reply finished. Try again.");
          return { status: true };
        } catch (error) {
          if (reader.signal.aborted) return { status: true };
          throw error;
        } finally {
          if (controller === reader) {
            controller = undefined;
            requestId = undefined;
          }
        }
      },
      abort() {
        controller?.abort();
      },
      async abortRequest() {
        if (requestId) await client.assistant.cancel.mutate({ mailboxId, requestId });
        controller?.abort();
      },
    };
  }, [state.mailboxId, client, cache, trpc]);
  return (
    <div className="mail-assistant-client flex min-h-0 flex-1 flex-col">
      <ChatProvider
        key={state.mailboxId}
        authConfig={{ sessionId: state.mailboxId }}
        apiHandler={adapter}
        autoLoadHistory
        tools={tools}
        markdownComponents={markdownComponents}
        statusComponents={statusComponents}
      >
        <MailChat
          includeThread={includeThread}
          canInclude={!!(currentId && folder)}
          onContext={() =>
            setContext(includeThread || !currentId || !folder ? null : { id: currentId, folder })
          }
        />
      </ChatProvider>
    </div>
  );
}

function MailChat({
  includeThread,
  canInclude,
  onContext,
}: {
  includeThread: boolean;
  canInclude: boolean;
  onContext(): void;
}) {
  const chat = useChatContext();
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="react-ai-agent flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {chat.messages?.length || chat.isLoading || chat.isLoadingHistory ? (
          <ChatCore
            contentPaddingStart={16}
            contentPaddingEnd={20}
            keepUserMessageInView={false}
            useGradientMask={false}
            showWelcome={false}
          />
        ) : (
          <div className="flex h-full flex-col justify-center px-6 py-8">
            <AssistantIcon className="mb-4 size-6" />
            <h3 className="text-lg font-medium tracking-tight">A little help with your mail</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
              Find a conversation, catch up, or start a reply.
            </p>
            <div className="mt-5 space-y-0.5 rounded-xl bg-muted/40 p-1">
              {suggestions.map(({ icon: Icon, label, prompt }) => (
                <button
                  key={label}
                  type="button"
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] hover:bg-accent"
                  onClick={() => {
                    setDraft(prompt);
                    input.current?.focus();
                  }}
                >
                  <Icon className="size-4 shrink-0" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <ChatInputDefault
        layout="inline"
        mode="default"
        value={draft}
        onValueChange={setDraft}
        inputRef={input}
        label="Message the mail assistant"
        placeholder="Ask about your mail…"
        maxLength={16000}
        enableLive={false}
        enableAttachments={false}
        showOptions={false}
        showActivityGlow={false}
        canSendWhileStreaming={false}
        onSendMessage={async (params) => {
          const sent = draft;
          setDraft("");
          try {
            await chat.sendMsg?.(params);
          } catch (error) {
            setDraft((value) => value || sent);
            throw error;
          }
        }}
        toolbarContent={
          canInclude ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-pressed={includeThread}
              className="h-7 gap-1.5 text-xs text-muted-foreground"
              onClick={onContext}
            >
              <Mail className="size-3.5" />
              Use open email
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
