"use client";
import { memo, useMemo, useState } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import {
  type AssistantMessage,
  type AssistantPart,
  type PermissionAccessRequest,
  type AssistantAutomationActivationReview,
  parseAssistantAutomationReport,
  assistantMessageImages,
} from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { AssistantToolActivity } from "./AssistantToolActivity";
import { AssistantLiveIndicator } from "./AssistantLiveIndicator";
import { assistantToolState } from "./tool-presentation";
import { AssistantCopyButton } from "./AssistantCopyButton";
import { AssistantAccessRequest, permissionRequest } from "./AssistantAccessRequest";
import {
  AssistantAutomationActivation,
  automationActivationRequest,
} from "./AssistantAutomationActivation";

type AccessReview = {
  clientId: string;
  reviewingAccess?: boolean;
  accessChanged?: boolean;
  onReviewAccess(request: PermissionAccessRequest): void;
  actionDisabled?: boolean;
  onContinue?(message: string): Promise<boolean>;
};

export function AssistantTranscript({
  messages,
  active,
  pending,
  error,
  hasMore,
  onEarlier,
  clientId,
  reviewingAccess,
  accessChanged,
  onReviewAccess,
  actionDisabled,
  onContinue,
  automated = false,
}: {
  messages: AssistantMessage[];
  active: boolean;
  pending?: "Sending" | "Working";
  error?: string | null;
  hasMore?: boolean;
  onEarlier(): Promise<void>;
  automated?: boolean;
} & AccessReview) {
  const reducedMotion = useReducedMotion();
  const {
    scrollRef: scroll,
    contentRef: content,
    isAtBottom,
    scrollToBottom,
    stopScroll,
  } = useStickToBottom({
    initial: "instant",
    resize: reducedMotion ? "instant" : "smooth",
  });
  const [earlier, setEarlier] = useState(false);
  const lastMessage = messages.at(-1);
  const lastPart = lastMessage?.parts?.at(-1);
  // Text can remain unchanged while the agent works. Only an actual activity
  // indicator (thinking/tool work) or a question replaces the general status.
  const hasLiveIndicator =
    lastMessage?.role === "assistant" &&
    ((lastPart?.type === "thinking" && !!lastPart.text) ||
      (lastPart?.tool && assistantToolState(lastPart.tool, active) === "running") ||
      (lastPart?.type === "interaction" && lastPart.interaction?.needsResponse));
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroll}
        role="log"
        aria-label="Conversation"
        aria-live="off"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 [overflow-anchor:none]"
        style={{ scrollPaddingBottom: "var(--assistant-composer-height, 0px)" }}
      >
        <div
          ref={content}
          className="mx-auto grid w-full max-w-3xl gap-8 py-6 sm:gap-10"
          style={{ paddingBottom: "calc(var(--assistant-composer-height, 0px) + 24px)" }}
        >
          {hasMore && (
            <Button
              variant="ghost"
              disabled={earlier}
              onClick={async () => {
                const height = scroll.current!.scrollHeight;
                stopScroll();
                setEarlier(true);
                try {
                  await onEarlier();
                  requestAnimationFrame(() => {
                    if (scroll.current)
                      scroll.current.scrollTop += scroll.current.scrollHeight - height;
                  });
                } finally {
                  setEarlier(false);
                }
              }}
            >
              {earlier ? "Loading earlier messages…" : "Load earlier messages"}
            </Button>
          )}
          {messages.map((message) =>
            message.role === "user" && automated ? (
              <details
                key={message.id}
                className="rounded-xl bg-card px-4 py-3 text-xs text-muted-foreground"
              >
                <summary className="cursor-pointer select-none">Investigation instructions</summary>
                <p className="mt-4 whitespace-pre-wrap break-words leading-6">{message.text}</p>
              </details>
            ) : message.role === "user" ? (
              <AssistantUserMessage key={message.id} message={message} />
            ) : (
              <AssistantMessageView
                key={message.id}
                message={message}
                active={active && message.id === messages.at(-1)?.id}
                clientId={clientId}
                reviewingAccess={reviewingAccess}
                accessChanged={accessChanged}
                onReviewAccess={onReviewAccess}
                actionDisabled={actionDisabled || active || !!pending || accessChanged}
                onContinue={onContinue}
                automated={automated}
              />
            ),
          )}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {(pending || (active && !hasLiveIndicator)) && (
            <AssistantLiveIndicator label={pending ?? "Working"} />
          )}
        </div>
      </div>
      {!isAtBottom && (
        <Button
          variant="secondary"
          size="sm"
          className="absolute z-20 self-center"
          style={{ bottom: "calc(var(--assistant-composer-height, 0px) + 8px)" }}
          onClick={() => void scrollToBottom({ animation: reducedMotion ? "instant" : "smooth" })}
        >
          <Icon name="arrow-down" />
          Latest messages
        </Button>
      )}
    </div>
  );
}
function AssistantMessageView({
  message,
  active,
  clientId,
  reviewingAccess,
  accessChanged,
  onReviewAccess,
  actionDisabled,
  onContinue,
  automated,
}: { message: AssistantMessage; active: boolean; automated?: boolean } & AccessReview) {
  const parts = message.parts?.length ? message.parts : [{ type: "text", text: message.text }];
  const response = parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => (automated ? parseAssistantAutomationReport(part.text!).text : part.text))
    .join("\n\n");
  const groups: Array<AssistantPart | AssistantPart[]> = [];
  const requests = new Map<AssistantPart, PermissionAccessRequest>();
  const activations = new Map<AssistantPart, AssistantAutomationActivationReview>();
  for (const part of parts) {
    const request = permissionRequest(part, clientId);
    const activation = automationActivationRequest(part);
    if (request) {
      requests.set(part, request);
      groups.push(part);
    } else if (activation) {
      activations.set(part, activation);
      groups.push(part);
    } else if (part.type === "thinking" || part.type === "tool") {
      const last = groups.at(-1);
      if (Array.isArray(last)) last.push(part);
      else groups.push([part]);
    } else groups.push(part);
  }
  return (
    <article className="group/response grid min-w-0 gap-4" aria-label="Assistant response">
      {groups.map((part, i) =>
        Array.isArray(part) ? (
          <AssistantToolActivity
            key={i}
            parts={part}
            active={active}
            streaming={active && i === groups.length - 1}
          />
        ) : requests.has(part) ? (
          <AssistantAccessRequest
            key={part.id ?? i}
            request={requests.get(part)!}
            disabled={reviewingAccess}
            accessChanged={accessChanged}
            onReview={onReviewAccess}
          />
        ) : activations.has(part) ? (
          <AssistantAutomationActivation
            key={part.id ?? i}
            request={activations.get(part)!}
            disabled={actionDisabled || reviewingAccess}
            onContinue={onContinue}
          />
        ) : part.type === "text" && part.text ? (
          <AssistantMarkdown key={part.id ?? i} streaming={active && i === groups.length - 1}>
            {automated ? parseAssistantAutomationReport(part.text).text : part.text}
          </AssistantMarkdown>
        ) : part.type === "compaction" ? (
          <p key={i} className="text-xs text-muted-foreground">
            Earlier context was summarized.
          </p>
        ) : null,
      )}
      {response && !active && (
        <div className="-ms-2 -mt-2 flex items-center">
          <AssistantCopyButton
            value={response}
            label="Copy response"
            compact
            className="sm:opacity-0 sm:group-hover/response:opacity-100 sm:focus-visible:opacity-100"
          />
        </div>
      )}
    </article>
  );
}

const AssistantUserMessage = memo(function AssistantUserMessage({
  message,
}: {
  message: AssistantMessage;
}) {
  const images = useMemo(() => assistantMessageImages(message.attachments), [message.attachments]);
  return (
    <div className="ms-auto max-w-[90%] rounded-3xl bg-card px-5 py-3 text-base leading-7 text-foreground whitespace-pre-wrap break-words sm:max-w-[85%] sm:px-6 sm:text-[17px] sm:leading-8">
      {!!message.attachments?.length && (
        <div className="mb-2 flex flex-wrap justify-end gap-2" aria-label="Message images">
          {images.map((image, index) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={index}
              src={`data:${image.mime};base64,${image.data}`}
              alt={image.name}
              className="max-h-48 max-w-full rounded-xl object-contain"
            />
          ))}
        </div>
      )}
      {message.text}
    </div>
  );
});
