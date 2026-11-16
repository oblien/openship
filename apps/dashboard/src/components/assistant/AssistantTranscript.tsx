"use client";

import { DisclosureSummary } from "@/components/ui/DisclosureSummary";
import { useMemo, useState } from "react";
import { ChatCore, ChatSnapshotProvider, type ChatMessage } from "@mindwire-ai/client";
import { normalizeMindwireMessages } from "@mindwire-ai/client/mindwire";
import {
  type AssistantMessage,
  type AssistantPart,
  type PermissionAccessRequest,
  type AssistantAutomationActivationReview,
  parseAssistantAutomationReport,
  assistantMessageImages,
} from "@repo/contracts";
import { AssistantLiveIndicator } from "./AssistantLiveIndicator";
import { AssistantAccessRequest, permissionRequest } from "./AssistantAccessRequest";
import {
  AssistantAutomationActivation,
  automationActivationRequest,
} from "./AssistantAutomationActivation";

import { assistantTools, visibleAssistantParts } from "./assistant-client-tools";

import { assistantMarkdownComponents } from "./AssistantMarkdown";
import { copyText } from "@/lib/clipboard";
import markdownStyles from "./assistant-markdown.module.css";
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
  const [earlier, setEarlier] = useState(false);
  const rows = useMemo(
    () =>
      normalizeMindwireMessages(
        messages.map((message) => ({
          ...message,
          parts: visibleAssistantParts(message),
          attachments: assistantMessageImages(message.attachments),
        })),
        {
          isActive: (message) => active && message.id === messages.at(-1)?.id,
          transform(row, message, part) {
            if (automated && message.role === "user")
              return { ...row, sender: "ai", type: "status", action: "openship.instructions" };
            if (part) {
              const request = permissionRequest(part as AssistantPart, clientId);
              if (request)
                return {
                  ...row,
                  action: "openship.access",
                  metadata: { ...row.metadata, request },
                };
              const activation = automationActivationRequest(part as AssistantPart);
              if (activation)
                return {
                  ...row,
                  action: "openship.activation",
                  metadata: { ...row.metadata, activation },
                };
            }
            return automated && row.type === "ai"
              ? { ...row, text: parseAssistantAutomationReport(row.text ?? "").text }
              : row;
          },
        },
      ),
    [messages, active, clientId, automated],
  );
  const thinking = active && messages.at(-1)?.parts?.at(-1)?.type === "thinking";
  const statusComponents = useMemo(
    () => ({
      "openship.access": (props: unknown) => (
        <AssistantAccessRequest
          request={
            (props as { message: ChatMessage }).message.metadata!.request as PermissionAccessRequest
          }
          disabled={reviewingAccess}
          accessChanged={accessChanged}
          onReview={onReviewAccess}
        />
      ),
      "openship.activation": (props: unknown) => (
        <AssistantAutomationActivation
          request={
            (props as { message: ChatMessage }).message.metadata!
              .activation as AssistantAutomationActivationReview
          }
          disabled={actionDisabled || active || !!pending || accessChanged || reviewingAccess}
          onContinue={onContinue}
        />
      ),
      "openship.instructions": (props: unknown) => (
        <details className="rounded-xl bg-card px-4 py-3 text-xs text-muted-foreground">
          <DisclosureSummary className="cursor-pointer select-none">
            Investigation instructions
          </DisclosureSummary>
          <p className="mt-4 whitespace-pre-wrap break-words leading-6">
            {(props as { message: ChatMessage }).message.text}
          </p>
        </details>
      ),
    }),
    [reviewingAccess, accessChanged, onReviewAccess, actionDisabled, active, pending, onContinue],
  );
  return (
    <div
      className={`openship-assistant-client ${markdownStyles.host} flex min-h-0 flex-1 flex-col`}
    >
      <ChatSnapshotProvider
        sessionId={`${clientId}:${messages[0]?.chatId ?? "conversation"}`}
        messages={rows}
        active={active}
        hasMore={hasMore}
        loadingEarlier={earlier}
        onEarlier={async () => {
          setEarlier(true);
          try {
            await onEarlier();
          } finally {
            setEarlier(false);
          }
        }}
        tools={assistantTools}
        statusComponents={statusComponents}
        markdownComponents={assistantMarkdownComponents}
        copyText={copyText}
      >
        <div className="react-ai-agent flex h-full min-h-0 flex-col">
          <ChatCore
            contentPaddingStart={24}
            contentPaddingEnd={24}
            useGradientMask={false}
            showWelcome={false}
            showLoadingIndicator={false}
            keepUserMessageInView={false}
            footer={
              <div
                className="mx-auto w-full max-w-3xl px-4"
                style={{ paddingBottom: "calc(var(--assistant-composer-height, 0px) + 24px)" }}
              >
                {error && (
                  <p role="alert" className="mb-3 text-sm text-danger">
                    {error}
                  </p>
                )}
                {(pending || (active && !thinking)) && (
                  <AssistantLiveIndicator label={pending ?? "Working"} />
                )}
              </div>
            }
          />
        </div>
      </ChatSnapshotProvider>
    </div>
  );
}
