"use client";

import { useState } from "react";
import { chatNativeCommands, chatSlackCommands, type ChatAppView } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useScopedMutation } from "@/hooks/use-scoped-resource";
import { chatAppsApi } from "@/lib/api/chat-apps";
import { ChatAppLogo, PROVIDER_NAMES } from "./ChatAppForm";
import { chatAppGuide } from "./chat-app-guides";

export function ChatCommandMenu({
  connection: c,
  onClose,
  onChanged,
}: {
  connection: ChatAppView;
  onClose(): void;
  onChanged(): void;
}) {
  const action = useScopedMutation();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const close = () => {
    if (!action.busy) onClose();
  };
  const focus = useDialogFocus(close);
  const slack = c.provider === "slack";
  const commands = chatNativeCommands(c.purpose);
  const definitions = JSON.stringify(
    chatSlackCommands(c.purpose, c.transport === "webhook" ? c.webhookUrl : undefined),
    null,
    2,
  );
  async function sync() {
    const result = await action.execute(() => chatAppsApi.syncCommands(c));
    onChanged();
    if (result) setSaved(true);
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(definitions);
      setCopied(true);
    } catch {
      /* diagnostics-ignore: Clipboard denial is shown inline with a manual copy alternative. */
      action.setError("Couldn’t copy. Select and copy the definitions below.");
    }
  }
  return (
    <Modal
      isOpen
      onClose={close}
      closable={!action.busy}
      showCloseButton={false}
      width="680px"
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
        aria-labelledby="native-commands-title"
        className="flex min-h-0 flex-1 flex-col outline-none"
      >
        <header className="flex items-center gap-3 p-6">
          <ChatAppLogo provider={c.provider} />
          <div className="flex-1">
            <h3 id="native-commands-title" className="text-lg font-medium">
              {PROVIDER_NAMES[c.provider]} commands
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">Choose a command as you type /.</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close commands"
            onClick={close}
            disabled={action.busy}
          >
            <Icon name="close" />
          </Button>
        </header>
        <div className="min-h-0 overflow-y-auto px-6 pb-6 space-y-5">
          <p className="text-sm leading-6 text-muted-foreground">
            {slack
              ? "Update this connector, then copy these entries into features.slash_commands in your Slack app’s manifest. Keep your other app settings and commands."
              : c.provider === "telegram"
                ? "Your bot’s command menu updates when you enable or save it. Type / or open Menu in Telegram to see its commands."
                : "Type /openship in Discord to choose an action and fill in its arguments. Commands update when you enable or save this bot."}
          </p>
          {slack ? (
            <div className="rounded-xl bg-background p-4">
              <pre
                tabIndex={0}
                aria-label="Slack slash command definitions"
                className="max-h-64 overflow-auto text-xs leading-5 text-foreground"
              >
                {definitions}
              </pre>
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {commands.map((command) => (
                <div key={command.name} className="rounded-xl bg-background/70 p-3">
                  <code className="text-xs">
                    {c.provider === "telegram" ? "/" : "/openship "}
                    {command.name}
                    {command.argument ? ` <${command.argument}>` : ""}
                  </code>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {command.description}
                  </p>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs leading-5 text-muted-foreground">
            Menus reflect this bot’s roles. Each command still checks your linked account’s
            permissions.
          </p>
          <a
            href={chatAppGuide(c.provider)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            Setup guide <Icon name="arrow-up-right" className="size-4" />
          </a>
          {!c.enabled && (
            <p className="text-sm text-muted-foreground">Enable this bot to update its commands.</p>
          )}
          {action.error && (
            <p role="alert" className="text-sm text-danger">
              {action.error}
            </p>
          )}
          {saved && (
            <p role="status" className="text-sm">
              {slack
                ? "Connector updated. Paste the definitions into Slack to finish."
                : "Command menu updated."}
            </p>
          )}
        </div>
        <footer className="flex shrink-0 flex-wrap justify-end gap-3 border-t border-border/40 p-5">
          {slack && (
            <Button variant="secondary" onClick={copy}>
              <Icon name={copied ? "check" : "copy"} className="size-4" />
              {copied ? "Copied" : "Copy definitions"}
            </Button>
          )}
          <Button onClick={sync} disabled={action.busy || !c.enabled || saved}>
            <Icon
              name={action.busy ? "spinner" : "refresh"}
              className={`size-4 ${action.busy ? "animate-spin" : ""}`}
            />
            {slack ? "Update connector" : "Refresh command menu"}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
