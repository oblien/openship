"use client";
import { useCallback, useState } from "react";
import type {
  ChatAppProvider,
  ChatAppCreate,
  ChatAppPurpose,
  ChatAppTransport,
  ChatAppConfiguration,
  ChatAppView,
} from "@repo/contracts";
import {
  chatAppConnectionFields,
  CHAT_APP_PROVIDER_NAMES as PROVIDER_NAMES,
} from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Modal } from "@/components/ui/Modal";
import { ChannelLogo } from "@/components/ui/ChannelLogo";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useScopedMutation, useScopedResource } from "@/hooks/use-scoped-resource";
import { chatAppsApi } from "@/lib/api/chat-apps";
import { chatAppGuide } from "./chat-app-guides";
import { ChatAppPurposePicker } from "./ChatAppPurposePicker";
import { cn } from "@/lib/utils";
export { CHAT_APP_PROVIDER_NAMES as PROVIDER_NAMES } from "@repo/contracts";
export function ChatAppLogo({ provider }: { provider: ChatAppProvider }) {
  return <ChannelLogo kind={provider === "teams" ? "msteams" : provider} className="size-7" />;
}
const credentialKeys = [
  "botToken",
  "appToken",
  "signingSecret",
  "webhookSecret",
  "publicKey",
  "clientSecret",
] as const;
export function ChatAppSettingsDialog({
  connection,
  onClose,
  onSaved,
}: {
  connection: ChatAppView;
  onClose(): void;
  onSaved(): void;
}) {
  const query = useScopedResource(
    useCallback(() => chatAppsApi.configuration(connection.id), [connection.id]),
  );
  const focus = useDialogFocus(onClose, !query.data);
  if (query.data)
    return (
      <ChatAppForm
        key={query.data.revision}
        provider={connection.provider}
        connection={query.data}
        onClose={onClose}
        onCreated={onSaved}
        onReload={query.refresh}
      />
    );
  return (
    <Modal isOpen onClose={onClose} width="600px" maxWidth="calc(100vw - 32px)">
      <div
        ref={focus.dialog}
        onKeyDown={focus.onKeyDown}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Connection settings"
        className="p-7 outline-none"
      >
        <h2 className="text-xl font-medium">Connection settings</h2>
        {query.error ? (
          <>
            <p role="alert" className="my-5 text-sm text-danger">
              {query.error}
            </p>
            <Button variant="secondary" onClick={query.refresh}>
              Try again
            </Button>
          </>
        ) : (
          <p role="status" className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
            <Icon name="spinner" className="size-4 animate-spin" />
            Loading bot settings…
          </p>
        )}
      </div>
    </Modal>
  );
}
export function ChatAppForm({
  provider,
  onClose,
  onCreated,
  connection,
  onReload,
  initialPurpose,
  initialTransport,
}: {
  provider: ChatAppProvider;
  onClose: () => void;
  onCreated: () => void;
  connection?: ChatAppConfiguration;
  onReload?(): void;
  initialPurpose?: ChatAppPurpose;
  initialTransport?: ChatAppTransport;
}) {
  const [purpose, setPurpose] = useState<ChatAppPurpose | null>(
    connection?.purpose ?? initialPurpose ?? "assistant",
  );
  const [transport, setTransport] = useState<ChatAppTransport>(
    connection?.transport ?? initialTransport ?? (provider === "teams" ? "webhook" : "outbound"),
  );
  const credentialFields = chatAppConnectionFields(provider, transport);
  const [values, setValues] = useState<Record<string, string>>({
    name: connection?.name ?? PROVIDER_NAMES[provider],
    channels: connection?.channelIds.join(", ") ?? "",
    workspaceId: connection?.workspaceId ?? "",
    applicationId: connection?.applicationId ?? "",
    serviceUrl: connection?.serviceUrl ?? "",
  });
  const action = useScopedMutation();
  const focus = useDialogFocus(() => {
    if (!action.busy) onClose();
  });
  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));
  const channelIds = [...new Set(values.channels!.split(/[\s,]+/).filter(Boolean))];
  const channelNoun =
    provider === "telegram" ? "chat" : provider === "teams" ? "conversation" : "channel";
  const channelHint =
    provider === "telegram"
      ? "Use message.chat.id from the bot’s getUpdates response. Keep the minus sign for group IDs."
      : provider === "discord"
        ? "Right-click each channel in Developer Mode and choose Copy Channel ID."
        : provider === "slack"
          ? "Copy each channel ID from its details in Slack. Invite the bot to those channels."
          : "Use the conversation.id from each Teams conversation you want to allow.";
  const channelPlaceholder =
    provider === "telegram"
      ? "123456789, -1001234567890"
      : provider === "slack"
        ? "C0123456789, C0987654321"
        : provider === "discord"
          ? "123456789012345678"
          : "19:…@thread.tacv2";
  const channelError = channelIds.length > 20 ? "Choose up to 20 destinations for this bot." : null;
  const close = () => {
    if (!action.busy) onClose();
  };
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (action.busy || !purpose || channelError || !channelIds.length || !values.name?.trim())
      return;
    const credentials: ChatAppCreate["credentials"] = {};
    for (const key of credentialKeys)
      if (values[key]?.trim() && credentialFields.some((f) => f.key === key))
        credentials[key] = values[key]!.trim();
    const input: ChatAppCreate = {
      name: values.name!.trim(),
      provider,
      purpose,
      transport,
      channelIds,
      credentials,
      ...Object.fromEntries(
        ["workspaceId", "applicationId", "serviceUrl"]
          .filter((k) => values[k])
          .map((k) => [k, values[k]!.trim()]),
      ),
    };
    const result = await action.execute(() => {
      if (!connection) return chatAppsApi.create(input);
      const { provider: _, ...settings } = input;
      return chatAppsApi.configure(connection.id, {
        ...settings,
        purpose,
        revision: connection.revision,
      });
    });
    onCreated();
    if (result) onClose();
  }
  return (
    <Modal
      isOpen
      onClose={close}
      closable={!action.busy}
      showCloseButton={false}
      width="1080px"
      maxWidth="calc(100vw - 32px)"
      maxHeight="calc(100dvh - 32px)"
      overflow="hidden"
    >
      <div
        ref={focus.dialog}
        onKeyDown={focus.onKeyDown}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-connect-title"
        className="flex min-h-0 flex-1 flex-col outline-none"
      >
        <header className="flex shrink-0 items-start gap-3 px-5 pb-6 pt-5 sm:gap-4 sm:px-7 sm:pt-7">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-background/70">
            <ChatAppLogo provider={provider} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="chat-connect-title" className="text-xl font-medium text-foreground">
              {connection ? "Edit" : "Connect"} {PROVIDER_NAMES[provider]}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Your apps, one message away.</p>
          </div>
          <a
            href={chatAppGuide(provider)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 hidden items-center gap-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:inline-flex"
          >
            Setup guide <Icon name="arrow-up-right" className="size-3.5" />
          </a>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close connection setup"
            onClick={close}
            disabled={action.busy}
            className="-me-1 -mt-1 shrink-0 sm:ms-2"
          >
            <Icon name="close" className="size-5" />
          </Button>
        </header>
        <form onSubmit={submit} aria-busy={action.busy} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 overflow-y-auto px-5 pb-6 sm:px-7">
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-8">
              <div className="min-w-0 space-y-5">
                <FormField id="chat-connection-name" label="Connection name">
                  <Input
                    id="chat-connection-name"
                    variant="filled"
                    value={values.name}
                    onChange={(event) => set("name", event.target.value)}
                    placeholder="e.g. Engineering assistant"
                    maxLength={80}
                    disabled={action.busy}
                    required
                  />
                </FormField>
                <section
                  aria-label="Bot credentials"
                  className="grid gap-x-5 gap-y-5 sm:grid-cols-2"
                >
                  {credentialFields.map((field) => {
                    const id = `chat-${provider}-${field.key}`;
                    const savedCredential =
                      !!connection && credentialKeys.some((key) => key === field.key);
                    const newTransportCredential =
                      savedCredential &&
                      transport !== connection.transport &&
                      ["appToken", "signingSecret", "webhookSecret", "publicKey"].includes(
                        field.key,
                      );
                    return (
                      <FormField
                        key={field.key}
                        id={id}
                        label={field.label}
                        hint={field.hint}
                        className={field.half ? "" : "sm:col-span-2"}
                      >
                        <Input
                          id={id}
                          aria-describedby={`${id}-hint`}
                          variant="filled"
                          type={field.secret ? "password" : "text"}
                          className="font-mono text-[13px]"
                          autoComplete="off"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          value={values[field.key] ?? ""}
                          placeholder={
                            savedCredential && !newTransportCredential
                              ? "Leave blank to keep the saved value"
                              : field.placeholder
                          }
                          maxLength={field.maxLength ?? 256}
                          onChange={(event) => set(field.key, event.target.value)}
                          disabled={action.busy}
                          required={!savedCredential || newTransportCredential}
                        />
                      </FormField>
                    );
                  })}
                </section>
                <section aria-label="Allowed destinations">
                  <div className="mb-2 flex items-center justify-between gap-4">
                    <label htmlFor="chat-destinations" className="text-sm">
                      Allowed {channelNoun} IDs
                    </label>
                    <span
                      className={cn(
                        "text-xs tabular-nums text-muted-foreground",
                        channelError && "text-danger",
                      )}
                    >
                      {channelIds.length} / 20
                    </span>
                  </div>
                  <Input
                    type="text"
                    variant="filled"
                    id="chat-destinations"
                    aria-describedby={`chat-destinations-hint${channelError ? " chat-destinations-error" : ""}`}
                    aria-invalid={!!channelError}
                    className="font-mono text-[13px]"
                    value={values.channels}
                    onChange={(event) => set("channels", event.target.value)}
                    onPaste={(event) => {
                      const text = event.clipboardData.getData("text");
                      if (!/[\r\n]/.test(text)) return;
                      event.preventDefault();
                      const input = event.currentTarget;
                      input.setRangeText(
                        text.replace(/\s*[\r\n]+\s*/g, ", "),
                        input.selectionStart ?? input.value.length,
                        input.selectionEnd ?? input.value.length,
                        "end",
                      );
                      set("channels", input.value);
                    }}
                    placeholder={channelPlaceholder}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={action.busy}
                    required
                  />
                  <p
                    id="chat-destinations-hint"
                    className="mt-2 text-xs leading-5 text-muted-foreground"
                  >
                    Separate IDs with commas. {channelHint}
                  </p>
                  {channelError && (
                    <p
                      id="chat-destinations-error"
                      role="alert"
                      className="mt-2 text-xs text-danger"
                    >
                      {channelError}
                    </p>
                  )}
                  {(provider === "telegram" || provider === "teams") && (
                    <p className="mt-2 flex items-center gap-2 text-xs leading-5 text-muted-foreground">
                      <Icon name="users" className="size-3.5 shrink-0" />
                      Replies are visible to everyone in these chats.
                    </p>
                  )}
                </section>
              </div>
              <aside
                aria-label="Connection settings"
                className="min-w-0 space-y-5 rounded-2xl bg-background/40 p-5"
              >
                <ChatAppPurposePicker
                  value={purpose}
                  onChange={setPurpose}
                  disabled={action.busy}
                  stacked
                />
                <details
                  className="group border-t border-border/40 pt-4"
                  open={provider === "teams"}
                >
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-md py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">Connection settings</span>
                      <span className="mt-1 block leading-5 text-muted-foreground">
                        OpenShip · {transport === "outbound" ? "Direct connection" : "Webhook"}
                      </span>
                    </span>
                    <Icon
                      name="chevron-down"
                      className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                    />
                  </summary>
                  <div className="space-y-3 pt-4">
                    <div className="grid gap-4">
                      {provider !== "teams" && (
                        <FormField id="chat-transport" label="Connection method">
                          <CustomSelect
                            id="chat-transport"
                            aria-label="Connection transport"
                            value={transport}
                            options={[
                              {
                                value: "outbound",
                                label: "Direct connection",
                                description: "No public URL needed",
                              },
                              {
                                value: "webhook",
                                label: "Webhook",
                                description: "Requires public HTTPS",
                              },
                            ]}
                            onChange={(value) => setTransport(value as ChatAppTransport)}
                            variant="filled"
                            triggerClassName="bg-muted/60 hover:bg-muted"
                            disabled={action.busy}
                          />
                        </FormField>
                      )}
                    </div>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {transport === "outbound"
                        ? "No public URL needed. Keep OpenShip running with internet access."
                        : provider === "teams"
                          ? "Microsoft Teams requires a public HTTPS bot endpoint. Local Desktop alone cannot receive Teams messages."
                          : "Requires a public HTTPS OpenShip API. After saving, enable the bot and register its webhook URL."}
                    </p>
                  </div>
                </details>
              </aside>
            </div>

            <a
              href={chatAppGuide(provider)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
            >
              Setup guide <Icon name="arrow-up-right" className="size-3.5" />
            </a>
          </div>
          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border/40 px-5 py-4 sm:px-7">
            <div className={cn("min-w-0", action.error ? "w-full" : "flex-1")}>
              {action.error ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p role="alert" className="text-sm text-danger">
                    {action.error}
                  </p>
                  {onReload && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={action.busy}
                      onClick={onReload}
                    >
                      Reload settings
                    </Button>
                  )}
                </div>
              ) : (
                <p className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                  <Icon name="pause" className="size-3.5" />
                  <span className="hidden sm:inline">
                    {connection ? "Bot settings" : "Starts paused"}
                  </span>
                  <span className="sm:hidden">{connection ? "Settings" : "Paused"}</span>
                </p>
              )}
            </div>
            <div className="ms-auto flex items-center gap-2">
              <Button type="button" variant="ghost" onClick={close} disabled={action.busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={action.busy || !purpose || !!channelError}>
                {action.busy ? "Saving…" : connection ? "Save changes" : "Save connector"}
                <Icon
                  name={action.busy ? "spinner" : "arrow-right"}
                  className={cn("size-4", action.busy && "animate-spin")}
                />
              </Button>
            </div>
          </footer>
        </form>
      </div>
    </Modal>
  );
}

function FormField({
  id,
  label,
  hint,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <label htmlFor={id} className="mb-2 block text-sm">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="mt-2 text-xs leading-5 text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
