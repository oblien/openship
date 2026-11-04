"use client";
import { useState } from "react";
import Link from "next/link";
import {
  ASSISTANT_PROVIDER_LABELS,
  type AssistantProvider,
  type ChatAppView,
} from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { useScopedMutation, useScopedResource } from "@/hooks/use-scoped-resource";
import { assistantApi } from "@/lib/api/assistant";
import { chatAppsApi } from "@/lib/api/chat-apps";

export function ChatAssistantSettings({
  connection: c,
  canManage,
  onChanged,
  onConfigure,
}: {
  connection: ChatAppView;
  canManage: boolean;
  onChanged(): void;
  onConfigure?(): void;
}) {
  const mutation = useScopedMutation();
  const [editing, setEditing] = useState(false);
  async function disable() {
    if (!c.identityId || !c.assistantRevision) return;
    const saved = await mutation.execute(() =>
      chatAppsApi.assistant(c.id, {
        identityId: c.identityId!,
        revision: c.assistantRevision!,
        enabled: false,
      }),
    );
    if (saved) {
      setEditing(false);
      onChanged();
    }
  }
  if (c.purpose === "commands" && !c.assistant) return null;
  const allowed = c.purpose !== "commands" && c.assistantAllowed;
  const canConnect = allowed && c.linked && c.enabled;
  return (
    <section className="border-t border-border/40 pt-4" aria-label={`Assistant in ${c.name}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Icon name="assistant" className="size-5 shrink-0 text-info" />
          <div>
            <h4 className="text-sm font-medium">Your assistant</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              {!allowed
                ? "Assistant is off in this bot’s settings."
                : !c.linked
                  ? "Link your account first, then connect your agent."
                  : c.assistant
                    ? `${ASSISTANT_PROVIDER_LABELS[c.assistant.provider]} · ${c.enabled ? "Connected" : "Bot paused"}`
                    : "Optional · Use your own agent and approved Assistant access."}
            </p>
          </div>
        </div>
        {!allowed && canManage && onConfigure ? (
          <Button variant="secondary" size="sm" onClick={onConfigure}>
            Bot settings
          </Button>
        ) : canConnect && !editing ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setEditing(true)}
            disabled={mutation.busy}
          >
            {c.assistant ? "Change agent" : "Connect my assistant"}
            <Icon name="arrow-right" className="size-4" />
          </Button>
        ) : null}
      </div>
      {mutation.error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {mutation.error}
        </p>
      )}
      {editing && canConnect && (
        <div className="mt-4">
          <AgentChoice
            key={`${c.identityId}:${c.assistantRevision}`}
            connection={c}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              onChanged();
            }}
          />
        </div>
      )}
      {c.assistant && (editing || !allowed || !c.enabled) && (
        <Button
          className="mt-3"
          variant="ghost"
          size="sm"
          disabled={mutation.busy}
          onClick={disable}
        >
          Disconnect my assistant
        </Button>
      )}
    </section>
  );
}

function AgentChoice({
  connection: c,
  onCancel,
  onSaved,
}: {
  connection: ChatAppView;
  onCancel(): void;
  onSaved(): void;
}) {
  const status = useScopedResource(assistantApi.status);
  return status.loading ? (
    <p role="status" className="text-sm text-muted-foreground">
      Checking your assistant…
    </p>
  ) : status.error ? (
    <div>
      <p role="alert" className="text-sm text-danger">
        {status.error}
      </p>
      <Button variant="ghost" size="sm" onClick={status.refresh}>
        Retry
      </Button>
    </div>
  ) : !status.data?.enabled ? (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">
        Enable your assistant and connect Claude Code or Codex first.
      </p>
      <Button asChild variant="secondary" size="sm">
        <Link href="/assistant">
          Set up assistant <Icon name="arrow-up-right" />
        </Link>
      </Button>
    </div>
  ) : (
    <ConnectedAgentChoice connection={c} onCancel={onCancel} onSaved={onSaved} />
  );
}

function ConnectedAgentChoice({
  connection: c,
  onCancel,
  onSaved,
}: {
  connection: ChatAppView;
  onCancel(): void;
  onSaved(): void;
}) {
  const providers = useScopedResource(assistantApi.providers);
  const mutation = useScopedMutation();
  const [selected, setSelected] = useState<AssistantProvider>(c.assistant?.provider ?? "codex");
  const [model, setModel] = useState(c.assistant?.model ?? "");
  const ready = providers.data?.filter((p) => p.available && p.authStatus.configured) ?? [];
  const provider = ready.find((p) => p.id === selected) ?? ready[0];
  async function save() {
    if (!provider || !c.identityId || !c.assistantRevision) return;
    const saved = await mutation.execute(() =>
      chatAppsApi.assistant(c.id, {
        identityId: c.identityId!,
        revision: c.assistantRevision!,
        enabled: true,
        provider: provider.id,
        model,
      }),
    );
    if (saved) onSaved();
  }
  return (
    <div className="space-y-4">
      {providers.loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading your agents…
        </p>
      ) : providers.error ? (
        <div>
          <p role="alert" className="text-sm text-danger">
            {providers.error}
          </p>
          <Button variant="ghost" size="sm" onClick={providers.refresh}>
            Retry
          </Button>
        </div>
      ) : !ready.length ? (
        <p className="text-sm text-muted-foreground">
          Connect an agent in{" "}
          <Link className="text-foreground underline underline-offset-4" href="/assistant">
            Assistant → Your agents
          </Link>
          , then return here.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <div
            className="inline-flex gap-1 rounded-xl bg-muted/50 p-1"
            role="group"
            aria-label="Choose your agent"
          >
            {ready.map((p) => (
              <button
                type="button"
                key={p.id}
                aria-pressed={p.id === provider?.id}
                disabled={mutation.busy}
                onClick={() => {
                  setSelected(p.id);
                  setModel("");
                }}
                className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${p.id === provider?.id ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                <Icon name={p.id} className="size-4" />
                {ASSISTANT_PROVIDER_LABELS[p.id]}
              </button>
            ))}
          </div>
          {!!provider?.models.length && (
            <CustomSelect
              value={model}
              onChange={setModel}
              options={[
                { value: "", label: "Default model" },
                ...provider.models.map((m) => ({ value: m.id, label: m.label })),
              ]}
              variant="filled"
              className="w-full sm:max-w-64"
              disabled={mutation.busy}
            />
          )}
        </div>
      )}
      <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
        Uses your connected agent and the permissions you approved for Assistant. Deployment
        commands keep their separate chat permissions.{" "}
        {c.provider === "teams" || c.provider === "telegram"
          ? "Replies are visible to others in this chat; use a private bot conversation for private app information."
          : "Replies are private to you."}
      </p>
      {mutation.error && (
        <p role="alert" className="text-sm text-danger">
          {mutation.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={
            !provider || providers.loading || !!providers.error || mutation.busy || !c.enabled
          }
          onClick={save}
        >
          Connect my assistant
          <Icon name="arrow-right" />
        </Button>
        <Button size="sm" variant="ghost" disabled={mutation.busy} onClick={onCancel}>
          Cancel
        </Button>
        <Link
          href="/settings?tab=assistant"
          className="ms-auto text-xs text-muted-foreground hover:text-foreground"
        >
          Review assistant access ↗
        </Link>
      </div>
    </div>
  );
}
