"use client";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  CHAT_APP_PROVIDERS,
  CHAT_APP_PURPOSES,
  type ChatAppProvider,
  type ChatAppPurpose,
  type ChatAppTransport,
  type ChatAppView,
} from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { chatAppsApi } from "@/lib/api/chat-apps";
import { useSession } from "@/lib/auth-client";
import { useCloudResourceReady } from "@/context/CloudResourceContext";
import { useResourceScope, useScopedResource } from "@/hooks/use-scoped-resource";
import { ChatAppForm, ChatAppLogo, PROVIDER_NAMES, ChatAppSettingsDialog } from "./ChatAppForm";
import { ChatAppPairing } from "./ChatAppPairing";
import { ChatAppsEmptyState } from "./ChatAppsEmptyState";
import { ChatCommandReference } from "./ChatCommandReference";
import { chatAppGuide } from "./chat-app-guides";
import { ChatAppConnectionCard } from "./ChatAppConnectionCard";
export function ChatAppsSettings() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { isPending } = useSession();
  const cloudReady = useCloudResourceReady();
  const scope = useResourceScope();
  // Wait for the initial account identity before exposing editable connector drafts.
  // The scope key still clears those drafts on an actual account/workspace change.
  if (!mounted || isPending || !cloudReady)
    return (
      <div
        role="status"
        aria-label="Loading chat connections"
        className="h-36 animate-pulse rounded-2xl bg-card"
      />
    );
  return <ChatAppsContent key={scope} />;
}
function ChatAppsContent() {
  const { data, error, loading, refresh } = useScopedResource(chatAppsApi.status, 15000);
  const search = useSearchParams();
  const offered = search.get("connect");
  const offeredOrganization = search.get("organizationId");
  const wrongWorkspace = Boolean(
    offered && offeredOrganization && data && offeredOrganization !== data.organizationId,
  );
  const handled = useRef<string | null>(null);
  const [defaults, setDefaults] = useState<{
    purpose?: ChatAppPurpose;
    transport?: ChatAppTransport;
  }>({});
  const [adding, setAdding] = useState<ChatAppProvider | null>(null);
  const [editing, setEditing] = useState<ChatAppView | null>(null);
  useEffect(() => {
    if (
      !data?.canManage ||
      wrongWorkspace ||
      !offered ||
      handled.current === offered ||
      !CHAT_APP_PROVIDERS.includes(offered as ChatAppProvider)
    )
      return;
    handled.current = offered;
    const purpose = search.get("purpose") as ChatAppPurpose;
    const transport = search.get("transport") as ChatAppTransport;
    setDefaults({
      purpose: CHAT_APP_PURPOSES.includes(purpose) ? purpose : undefined,
      transport:
        ["outbound", "webhook"].includes(transport) &&
        !(offered === "teams" && transport === "outbound")
          ? transport
          : undefined,
    });
    setAdding(offered as ChatAppProvider);
  }, [data?.canManage, wrongWorkspace, offered, search]);
  return (
    <div className="space-y-7">
      {wrongWorkspace && (
        <p role="status" className="rounded-xl bg-card p-4 text-sm text-muted-foreground">
          This setup belongs to another workspace. Switch to that workspace to continue.
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <section aria-label="Connect a chat app" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {CHAT_APP_PROVIDERS.map((provider) => (
          <article key={provider} className="rounded-2xl bg-card p-5">
            <button
              aria-label={`Connect ${PROVIDER_NAMES[provider]}`}
              disabled={!data?.canManage}
              onClick={() => {
                setDefaults({});
                setAdding(provider);
              }}
              className="group w-full rounded-lg text-start disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <div className="mb-5 flex items-center justify-between">
                <ChatAppLogo provider={provider} />
                <Icon
                  name="plus"
                  className="size-4 text-muted-foreground group-hover:text-foreground"
                />
              </div>
              <p className="text-sm font-medium text-foreground">{PROVIDER_NAMES[provider]}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {provider === "teams"
                  ? "Requires a public bot endpoint"
                  : "Works locally · no public URL"}
              </p>
            </button>
            <a
              href={chatAppGuide(provider)}
              aria-label={`${PROVIDER_NAMES[provider]} setup guide`}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex items-center gap-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              Setup guide <Icon name="arrow-up-right" className="size-3.5" />
            </a>
          </article>
        ))}
      </section>
      <section className="min-w-0 space-y-3" aria-label="Connected chat apps">
        <h3 className="mb-4 text-sm font-medium">Your connections</h3>
        {loading ? (
          <div className="h-36 animate-pulse rounded-2xl bg-card" />
        ) : !data ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-card p-5">
            <p className="text-sm text-muted-foreground">Your connections couldn’t be loaded.</p>
            <Button variant="secondary" size="sm" onClick={refresh}>
              Try again
            </Button>
          </div>
        ) : !data.connections.length ? (
          <ChatAppsEmptyState />
        ) : (
          data.connections.map((c) => (
            <ChatAppConnectionCard
              key={c.id}
              connection={c}
              canManage={data.canManage}
              onEdit={() => setEditing(c)}
              onChanged={refresh}
            />
          ))
        )}
      </section>
      <ChatCommandReference />
      {adding && data && (
        <ChatAppForm
          provider={adding}
          initialPurpose={defaults.purpose}
          initialTransport={defaults.transport}
          onClose={() => setAdding(null)}
          onCreated={refresh}
        />
      )}
      {editing && data && (
        <ChatAppSettingsDialog
          connection={editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      <ChatAppPairing />
    </div>
  );
}
