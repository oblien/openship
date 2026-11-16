import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { MailIcon } from "@/components/icons/mail-icons";
import { AiProviderIcon } from "@/components/icons/ai-provider-icon";
import { useTRPC } from "@/providers/query-provider";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectAiDialog } from "@/components/settings/connect-ai-dialog";
import { ConnectMailAgentDialog } from "@/components/settings/connect-mail-agent-dialog";

const scopeLabels: Record<string, string> = {
  "mail:read": "Read mail",
  "mail:draft": "Drafts",
  "mail:send": "Send proposals",
};

export default function AgentsPage() {
  const trpc = useTRPC();
  const cache = useQueryClient();
  const [aiOpen, setAiOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const assistant = useQuery(trpc.assistant.state.queryOptions());
  const connections = useQuery(trpc.mailAgents.list.queryOptions());
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: trpc.assistant.pathKey() });
    void cache.invalidateQueries({ queryKey: trpc.mailAgents.pathKey() });
    void cache.invalidateQueries({ queryKey: trpc.outbox.pathKey() });
  };
  const onError = (error: { message: string }) => toast.error(error.message);
  const configure = useMutation(
    trpc.assistant.configure.mutationOptions({ onError, onSuccess: refresh }),
  );
  const disconnect = useMutation(
    trpc.assistant.disconnect.mutationOptions({ onError, onSuccess: refresh }),
  );
  const revoke = useMutation(
    trpc.mailAgents.revoke.mutationOptions({ onError, onSuccess: refresh }),
  );
  const active = connections.data?.filter((c) => !c.revokedAt && c.expiresAt > Date.now()) ?? [];
  const connected = assistant.data?.connection;
  const enabled = assistant.data?.enabled;
  return (
    <div className="mx-auto max-w-2xl space-y-8 py-5 text-sm sm:py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">AI & agents</h1>
        <p className="text-muted-foreground text-[13px]">Your AI, connected to your mailbox.</p>
      </header>
      <section aria-labelledby="assistant-heading" className="space-y-4">
        <div className="flex items-center gap-2">
          <MailIcon name="assistant" className="text-iconLight dark:text-iconDark" />
          <h2 id="assistant-heading" className="font-medium">
            Mail assistant
          </h2>
        </div>
        {assistant.isPending ? (
          <Skeleton className="h-28 rounded-xl" />
        ) : assistant.isError ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-xl border p-4"
          >
            <p className="text-muted-foreground text-[13px]">Could not load your AI connection.</p>
            <Button variant="ghost" size="sm" onClick={() => void assistant.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <div className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div className="min-w-0 space-y-1">
                <p className="flex items-center gap-2.5 font-medium">
                  {connected && (
                    <AiProviderIcon
                      provider={
                        connected.customProvider
                          ? "custom"
                          : connected.agent === "claude-code"
                            ? "anthropic"
                            : "openai"
                      }
                    />
                  )}
                  {connected?.name ??
                    (enabled ? "Connected assistant" : "A little help with your mail")}
                </p>
                <p className="text-muted-foreground max-w-sm text-[13px] leading-relaxed">
                  {connected || enabled
                    ? enabled
                      ? "Ready to chat and write with AI."
                      : "Paused. Your AI connection is saved."
                    : "Catch up on your inbox, find a message, or draft a reply."}
                </p>
                {connected?.model && (
                  <p className="text-muted-foreground max-w-xs truncate text-xs">
                    {connected.model.replace(/^openship-mail\//, "")}
                  </p>
                )}
              </div>
              {connected || enabled ? (
                <div className="flex items-center gap-2">
                  <Switch
                    aria-label="Enable mail assistant"
                    checked={!!enabled}
                    disabled={configure.isPending || disconnect.isPending}
                    onCheckedChange={(value) =>
                      configure.mutate({ enabled: value, allowSend: assistant.data?.allowSend })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disconnect.isPending}
                    onClick={() => disconnect.mutate()}
                  >
                    {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
                  </Button>
                </div>
              ) : (
                <Button size="sm" onClick={() => setAiOpen(true)}>
                  Connect AI
                </Button>
              )}
            </div>
            {enabled && (
              <div className="flex items-center justify-between gap-6 border-t px-4 py-3">
                <div className="space-y-1">
                  <label htmlFor="assistant-sends" className="text-[13px]">
                    Prepare send proposals
                  </label>
                  <p className="text-muted-foreground text-xs">
                    You review and approve every message in{" "}
                    <Link to="/mail/scheduled" className="underline underline-offset-2">
                      Scheduled
                    </Link>
                    .
                  </p>
                </div>
                <Switch
                  id="assistant-sends"
                  checked={assistant.data?.allowSend ?? false}
                  disabled={configure.isPending}
                  onCheckedChange={(value) => configure.mutate({ enabled: true, allowSend: value })}
                />
              </div>
            )}
          </div>
        )}
        <p className="text-muted-foreground text-xs leading-relaxed">
          Uses your AI account. Mail you ask it to read is shared with your provider.
        </p>
      </section>
      <section aria-labelledby="agents-heading" className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <MailIcon name="connect" className="text-iconLight dark:text-iconDark" />
            <h2 id="agents-heading" className="font-medium">
              Connected agents
            </h2>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setAgentOpen(true)}>
            <Plus />
            Add connection
          </Button>
        </div>
        {connections.isPending ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : connections.isError ? (
          <div role="alert" className="flex items-center justify-between rounded-xl border p-4">
            <p className="text-muted-foreground text-[13px]">Could not load connections.</p>
            <Button variant="ghost" size="sm" onClick={() => void connections.refetch()}>
              Retry
            </Button>
          </div>
        ) : active.length ? (
          <div className="divide-y overflow-hidden rounded-xl border">
            {active.map((connection) => (
              <div key={connection.id} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0 space-y-1">
                  <p className="truncate font-medium">{connection.name}</p>
                  <p className="text-muted-foreground text-xs">
                    {connection.scopes.map((scope) => scopeLabels[scope] ?? scope).join(" · ")}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Expires {new Date(connection.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate({ id: connection.id })}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border px-4 py-5">
            <p className="text-[13px]">Bring your own agent</p>
            <p className="text-muted-foreground mt-1 text-[13px] leading-relaxed">
              Connect an MCP-compatible agent and choose what it can do in this mailbox.
            </p>
          </div>
        )}
      </section>
      <ConnectAiDialog open={aiOpen} onOpenChange={setAiOpen} onConnected={refresh} />
      <ConnectMailAgentDialog open={agentOpen} onOpenChange={setAgentOpen} onConnected={refresh} />
    </div>
  );
}
