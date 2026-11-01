"use client";
import { useState } from "react";
import { CHAT_COMMANDS, chatCommandUsage, type ChatCommand } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/Tabs";
import { chatAppGuide } from "./chat-app-guides";

const groups = [
  { key: "assistant", label: "Assistant" },
  { key: "projects", label: "Projects & logs" },
  { key: "deployments", label: "Deployments" },
  { key: "account", label: "Account & help" },
] satisfies { key: ChatCommand["group"]; label: string }[];

export function ChatCommandReference() {
  const [group, setGroup] = useState<ChatCommand["group"]>("projects");
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  async function copy(command: string) {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(command);
      setCopied(command);
    } catch {
      setCopyError(true);
    }
  }
  return (
    <section className="space-y-4" aria-labelledby="chat-command-reference">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="chat-command-reference" className="text-sm font-medium text-foreground">
          Command reference
        </h3>
        <a
          href={`${chatAppGuide()}#commands`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          Full guide <Icon name="arrow-up-right" className="size-3.5" />
        </a>
      </div>
      <Tabs
        tabs={groups}
        value={group}
        onChange={setGroup}
        size="sm"
        idPrefix="chat-commands"
        ariaLabel="Command categories"
      />
      {groups.map(({ key }) => (
        <div
          key={key}
          role="tabpanel"
          id={`chat-commands-panel-${key}`}
          aria-labelledby={`chat-commands-tab-${key}`}
          hidden={group !== key}
        >
          <dl className="divide-y divide-border/40 rounded-2xl bg-card px-5">
            {CHAT_COMMANDS.filter((command) => command.group === key).map((command) => {
              const usage = chatCommandUsage(command);
              return (
                <div
                  key={command.verb}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 py-4 lg:grid-cols-[270px_minmax(0,1fr)_auto]"
                >
                  <dt className="min-w-0 text-foreground">
                    <code dir="ltr" className="block break-words text-xs">
                      {usage}
                    </code>
                  </dt>
                  <dd className="col-start-1 text-xs leading-relaxed text-muted-foreground lg:col-start-2 lg:row-start-1">
                    {command.description}
                  </dd>
                  <dd className="col-start-2 row-start-1 row-end-3 lg:col-start-3 lg:row-end-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Copy ${usage}`}
                      onClick={() => void copy(usage)}
                    >
                      <Icon name={copied === usage ? "check" : "copy"} className="size-3.5" />
                    </Button>
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      ))}
      {copyError && (
        <p role="alert" className="text-xs text-muted-foreground">
          Copy is unavailable in this browser. Select the command text to copy it.
        </p>
      )}
      <p role="status" className="sr-only">
        {copied ? `Copied ${copied}` : ""}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Replace{" "}
        <code dir="ltr" className="text-foreground">
          &lt;project-id&gt;
        </code>{" "}
        with an ID from{" "}
        <code dir="ltr" className="text-foreground">
          /openship projects
        </code>
        . Use the exact verification or confirmation command you receive.
      </p>
      <details className="group rounded-2xl bg-card px-5 py-4">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
          Example: redeploy a project
          <Icon
            name="chevron-down"
            className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
          />
        </summary>
        <ol className="mt-4 space-y-3 text-xs leading-relaxed text-muted-foreground">
          <li>
            1. Send{" "}
            <code dir="ltr" className="text-foreground">
              /openship projects
            </code>{" "}
            and copy your project’s ID.
          </li>
          <li>
            2. Send{" "}
            <code dir="ltr" className="text-foreground">
              /openship redeploy &lt;project-id&gt;
            </code>{" "}
            with that ID. Review the action in the reply.
          </li>
          <li>
            3. Send the returned{" "}
            <code dir="ltr" className="text-foreground">
              /openship confirm &lt;code&gt;
            </code>{" "}
            command within five minutes. The deployment then follows the normal pipeline.
          </li>
        </ol>
      </details>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Each person uses their own approved access. Redeploys and restarts need confirmation. No AI
        is required.
      </p>
    </section>
  );
}
