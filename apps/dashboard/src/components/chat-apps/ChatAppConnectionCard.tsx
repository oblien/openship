"use client";
import { useState } from "react";
import type { ChatAppView } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import DropdownMenu from "@/components/ui/DropdownMenu";
import { useScopedMutation } from "@/hooks/use-scoped-resource";
import { chatAppsApi } from "@/lib/api/chat-apps";
import { ChatAppLogo, PROVIDER_NAMES } from "./ChatAppForm";
import { ChatAssistantSettings } from "./ChatAssistantSettings";
import { CHAT_PURPOSE_LABELS } from "./ChatAppPurposePicker";
import { chatAppGuide } from "./chat-app-guides";
import { ChatCommandMenu } from "./ChatCommandMenu";

export function ChatAppConnectionCard({
  connection: c,
  canManage,
  onEdit,
  onChanged,
}: {
  connection: ChatAppView;
  canManage: boolean;
  onEdit(): void;
  onChanged(): void;
}) {
  const action = useScopedMutation();
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const status = !c.enabled
    ? "Paused"
    : c.transport === "webhook"
      ? "Enabled"
      : c.receiver?.state === "connected"
        ? "Connected"
        : c.receiver?.state === "error"
          ? "Needs attention"
          : c.receiver?.state === "retrying"
            ? "Reconnecting…"
            : "Connecting…";
  return (
    <article className="rounded-2xl bg-card p-5" aria-label={`${c.name} connection`}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <ChatAppLogo provider={c.provider} />
          <div>
            <h3 className="text-sm font-medium">{c.name}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {CHAT_PURPOSE_LABELS[c.purpose]} · <span role="status">{status}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canManage && (
            <>
              <Button variant="secondary" size="sm" disabled={action.busy} onClick={onEdit}>
                <Icon name="settings" className="size-4" />
                Settings
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={action.busy}
                onClick={() =>
                  void action.execute(() => chatAppsApi.enable(c, !c.enabled)).then(onChanged)
                }
              >
                {c.enabled ? "Pause" : "Enable bot"}
              </Button>
            </>
          )}
          {(canManage || c.linked) && (
            <DropdownMenu
              triggerLabel={`${c.name} actions`}
              disabled={action.busy}
              actions={[
                ...(canManage && c.provider !== "teams"
                  ? [
                      {
                        id: "commands",
                        label: "Native commands",
                        icon: <Icon name="terminal" className="size-4" />,
                        onClick: () => setCommandsOpen(true),
                      },
                    ]
                  : []),
                ...(c.linked
                  ? [
                      {
                        id: "unlink",
                        label: "Unlink my account",
                        icon: <Icon name="logout" className="size-4" />,
                        onClick: () =>
                          void action.execute(() => chatAppsApi.unlink(c.id)).then(onChanged),
                      },
                    ]
                  : []),
                ...(canManage
                  ? [
                      {
                        id: "remove",
                        label: "Remove connector",
                        variant: "danger" as const,
                        icon: <Icon name="trash" className="size-4" />,
                        onClick: () => setRemoving(true),
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </div>
      </header>
      {(c.issue || c.receiver?.error) && (
        <p role="status" className="mt-4 text-sm text-warning">
          {c.issue || c.receiver?.error}
        </p>
      )}
      {action.error && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {action.error}
        </p>
      )}
      <div className="mt-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 pt-4">
          <div className="flex items-center gap-3">
            <Icon name="user" className="size-5 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Your account</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {c.linked
                  ? "Linked · Uses your approved chat permissions."
                  : "Send this command to the bot to link your account and review access."}
              </p>
            </div>
          </div>
          {!c.linked && (
            <Button
              variant="secondary"
              size="sm"
              aria-label="Copy account linking command"
              onClick={() =>
                void navigator.clipboard.writeText("/openship link").then(() => setCopied(true))
              }
            >
              <code className="text-xs">/openship link</code>
              <Icon name={copied ? "check" : "copy"} className="size-3.5" />
            </Button>
          )}
        </div>
        <ChatAssistantSettings
          connection={c}
          canManage={canManage}
          onChanged={onChanged}
          onConfigure={canManage ? onEdit : undefined}
        />
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs">
        <a
          href={chatAppGuide(c.provider)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md py-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {PROVIDER_NAMES[c.provider]} setup guide
          <Icon name="arrow-up-right" className="size-3.5" />
        </a>
        {c.transport === "outbound" && (
          <span className="text-muted-foreground">Direct connection · No public URL needed</span>
        )}
      </div>
      {c.transport === "webhook" && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Bot webhook URL</summary>
          <div className="mt-2 flex items-center gap-3 rounded-xl bg-background p-3">
            <code className="min-w-0 flex-1 break-all">{c.webhookUrl}</code>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Copy webhook URL"
              onClick={() => void navigator.clipboard.writeText(c.webhookUrl)}
            >
              <Icon name="copy" className="size-4" />
            </Button>
          </div>
        </details>
      )}
      {removing && (
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border/40 pt-4">
          <p className="me-auto text-xs text-muted-foreground">
            Remove this connector and its linked access?
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={action.busy}
            onClick={() => setRemoving(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={action.busy}
            onClick={() =>
              void action
                .execute(() => chatAppsApi.remove(c.id))
                .then(() => {
                  setRemoving(false);
                  onChanged();
                })
            }
          >
            Remove connector
          </Button>
        </div>
      )}
      {commandsOpen && (
        <ChatCommandMenu
          connection={c}
          onClose={() => setCommandsOpen(false)}
          onChanged={onChanged}
        />
      )}
    </article>
  );
}
