"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { AssistantDialog } from "./AssistantDialog";
import { ChatAppForm } from "@/components/chat-apps/ChatAppForm";
import { chatAppsApi } from "@/lib/api/chat-apps";
import { useResourceScope, useScopedResource } from "@/hooks/use-scoped-resource";
import type { ToolResource } from "./tool-presentation";

/** A returned setup offer opens the existing human form, never an agent mutation. */
export function AssistantChatAppSetup({
  item,
}: {
  item: ToolResource & { setup: NonNullable<ToolResource["setup"]> };
}) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <>
      {saved ? (
        <Link className="text-xs font-medium hover:underline" href="/settings?tab=chat-apps">
          Connection saved · View settings
        </Link>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {item.action} <Icon name="arrow-right" className="size-3.5" />
        </Button>
      )}
      {open && (
        <SetupDialog
          setup={item.setup}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            setSaved(true);
          }}
        />
      )}
    </>
  );
}

function SetupDialog({
  setup,
  onClose,
  onSaved,
}: {
  setup: NonNullable<ToolResource["setup"]>;
  onClose(): void;
  onSaved(): void;
}) {
  const scope = useResourceScope();
  const originalScope = useRef(scope);
  const query = useScopedResource(chatAppsApi.status);
  useEffect(() => {
    if (scope !== originalScope.current) onClose();
  }, [scope, onClose]);
  if (scope !== originalScope.current) return null;
  if (query.data?.canManage && query.data.organizationId === setup.organizationId)
    return (
      <ChatAppForm
        provider={setup.provider}
        initialPurpose={setup.purpose}
        initialTransport={setup.transport}
        onClose={onClose}
        onCreated={onSaved}
      />
    );
  return (
    <AssistantDialog
      label="Connect chat app"
      isOpen
      onClose={onClose}
      width="480px"
      maxWidth="calc(100vw - 24px)"
    >
      <div className="grid gap-4 p-6 pe-14">
        <h2 className="text-lg font-medium">Connect chat app</h2>
        <p
          className="text-sm leading-6 text-muted-foreground"
          role={query.error ? "alert" : "status"}
        >
          {query.error ??
            (query.loading
              ? "Checking this workspace’s connection settings…"
              : query.data?.organizationId !== setup.organizationId
                ? "This setup belongs to another workspace. Return to that workspace to continue."
                : "A workspace admin can complete this setup in Settings → Chat apps.")}
        </p>
        {query.error && (
          <Button variant="secondary" size="sm" onClick={query.refresh}>
            Try again
          </Button>
        )}
      </div>
    </AssistantDialog>
  );
}
