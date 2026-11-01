"use client";
import { useState } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import {
  ASSISTANT_PROVIDER_LABELS,
  type AssistantProvider,
  type AssistantStatus,
} from "@repo/contracts";
import {
  useResourceScope,
  useScopedResource,
  useScopedMutation,
} from "@/hooks/use-scoped-resource";
import { assistantApi } from "@/lib/api/assistant";
import { assistantAutomationsApi } from "@/lib/api/assistant-automations";
import { tokensApi, type McpClientDetail } from "@/lib/api/tokens";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/Switch";
import { AssistantDialog } from "./AssistantDialog";
import { AgentConnections } from "./AgentConnections";
import { McpAccessEditor } from "@/app/(dashboard)/settings/_components/McpAccessEditor";
import { AccessCopyProvider, ASSISTANT_ACCESS_COPY } from "@/components/permissions/access-copy";

export function AssistantSettings() {
  const scope = useResourceScope();
  return <SettingsContent key={scope} />;
}
function SettingsContent() {
  const status = useScopedResource(assistantApi.status);
  const mutation = useScopedMutation();
  const [disable, setDisable] = useState(false);
  return (
    <>
      <section className="rounded-2xl bg-card p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <span className="rounded-xl bg-muted p-3">
              <Icon name="assistant" className="size-6" />
            </span>
            <div>
              <h2 className="text-lg font-medium">Your assistant</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                Your connected agent, your apps, your permissions. Manage its access here and build
                event-driven flows in Automations.
              </p>
            </div>
          </div>
          <span className="rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground">
            {status.loading
              ? "Loading…"
              : status.error
                ? "Unavailable"
                : status.data?.enabled
                  ? "Enabled"
                  : "Off"}
          </span>
        </div>
        {status.error && (
          <p role="alert" className="mt-4 text-sm text-danger">
            {status.error}
          </p>
        )}
        {!status.loading && !status.error && !status.data?.enabled && (
          <Link href="/assistant" className="mt-5 inline-block">
            <Button>
              Enable assistant <Icon name="arrow-right" className="size-4" />
            </Button>
          </Link>
        )}
        {status.data?.enabled && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-xl bg-background/60 p-4">
            <span className="flex items-center gap-2 text-sm">
              <Icon
                name={status.data.target?.kind === "server" ? "server" : "monitor"}
                className="size-4 text-muted-foreground"
              />
              {status.data.target?.name ?? "Assistant host"}
            </span>
            <Link href="/assistant" className="text-sm text-muted-foreground hover:text-foreground">
              Open assistant <span aria-hidden>↗</span>
            </Link>
          </div>
        )}
      </section>
      {status.data?.enabled && <EnabledSettings status={status.data} />}
      <section className="rounded-2xl bg-card p-5 sm:p-6">
        <h3 className="text-base font-medium">Chat apps & notifications</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Talk to your assistant from chat apps, control deployments with commands, and choose where
          automation results arrive.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href="/settings?tab=chat-apps" className="rounded-xl bg-muted px-4 py-2.5 text-sm">
            Chat apps <span aria-hidden>↗</span>
          </Link>
          <Link
            href="/settings?tab=notifications"
            className="rounded-xl bg-muted px-4 py-2.5 text-sm"
          >
            Notification channels <span aria-hidden>↗</span>
          </Link>
        </div>
      </section>
      {status.data?.enabled && (
        <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-card p-5 sm:p-6">
          <div>
            <h3 className="text-sm font-medium">Disable assistant</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Stops assistant access and blocks automations in this workspace.
            </p>
          </div>
          <Button variant="secondary" onClick={() => setDisable(true)}>
            Disable assistant
          </Button>
        </section>
      )}
      <AssistantDialog
        isOpen={disable}
        label="Disable assistant"
        onClose={() => setDisable(false)}
        closable={!mutation.busy}
        width="min(500px,94vw)"
        maxWidth="94vw"
      >
        <div className="p-7">
          <h2 className="text-xl font-medium">Disable your assistant?</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Active assistant work will stop. Automations cannot investigate or act until you enable
            the assistant again.
          </p>
          {mutation.error && (
            <p role="alert" className="mt-4 text-sm text-danger">
              {mutation.error}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" disabled={mutation.busy} onClick={() => setDisable(false)}>
              Cancel
            </Button>
            <Button
              disabled={mutation.busy}
              onClick={() =>
                void mutation.execute(async () => {
                  await assistantApi.disable();
                  setDisable(false);
                  status.refresh();
                })
              }
            >
              Disable assistant
            </Button>
          </div>
        </div>
      </AssistantDialog>
    </>
  );
}
function EnabledSettings({ status }: { status: AssistantStatus }) {
  const agents = useScopedResource(assistantApi.providers);
  const automations = useScopedResource(assistantAutomationsApi.overview);
  const mutation = useScopedMutation();
  const [selected, setSelected] = useState<AssistantProvider>("claude");
  const [connections, setConnections] = useState(false);
  const [detail, setDetail] = useState<McpClientDetail | null>(null);
  const [savingAccess, setSavingAccess] = useState(false);
  return (
    <>
      <section className="rounded-2xl bg-card p-5 sm:p-6">
        <h3 className="text-base font-medium">Connected accounts</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Conversations and automations use these connections on your assistant host.
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {(["claude", "codex"] as const).map((id) => {
            const agent = agents.data?.find((a) => a.id === id);
            return (
              <button
                type="button"
                key={id}
                onClick={() => {
                  setSelected(id);
                  setConnections(true);
                }}
                className="flex items-center gap-3 rounded-xl bg-background/60 p-4 text-start hover:bg-muted"
              >
                <Icon name={id} className="size-6" />
                <span className="flex-1">
                  <span className="block text-sm">{ASSISTANT_PROVIDER_LABELS[id]}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {agents.loading
                      ? "Checking…"
                      : agent?.authStatus.configured
                        ? "Connected"
                        : "Connect account"}
                  </span>
                </span>
                <Icon name="arrow-up-right" className="size-4 text-muted-foreground" />
              </button>
            );
          })}
        </div>
        {agents.error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {agents.error}
          </p>
        )}
      </section>
      <section className="rounded-2xl bg-card p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-medium">Permissions</h3>
            <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
              Review your assistant’s access. Each automation also limits its investigation and
              allowed action to the app you select.
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={mutation.busy}
            onClick={() =>
              void mutation.execute(async () => {
                const response = await tokensApi.getMcpClient(status.clientId!);
                setDetail(response.data);
              })
            }
          >
            Review access
          </Button>
        </div>
        {mutation.error && (
          <p role="alert" className="mt-4 text-sm text-danger">
            {mutation.error}
          </p>
        )}
      </section>
      <section className="rounded-2xl bg-card p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-medium">Pause all automations</h3>
            <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
              Stop new investigations and pending actions. Your regular conversations remain
              available.
            </p>
          </div>
          <Switch
            checked={automations.data?.paused ?? false}
            disabled={automations.loading || !!automations.error || mutation.busy}
            ariaLabel="Pause all automations"
            onChange={(paused) =>
              void mutation.execute(async () => {
                await assistantAutomationsApi.pause(paused);
                automations.refresh();
              })
            }
          />
        </div>
        <Link
          href="/assistant?tab=automations"
          className="mt-5 inline-flex items-center gap-2 text-sm"
        >
          Manage automations <Icon name="arrow-right" className="size-4" />
        </Link>
        {automations.error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {automations.error}
          </p>
        )}
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          Each flow has a daily run limit and cooldown. Investigations stop after 10 minutes. Your
          AI provider’s usage limits still apply.
        </p>
      </section>
      <AssistantDialog
        isOpen={connections}
        keepMounted
        label="AI connections"
        onClose={() => setConnections(false)}
        width="920px"
        maxWidth="96vw"
        maxHeight="92dvh"
      >
        <AgentConnections
          agents={agents.data ?? []}
          hostName={status.target?.name}
          selected={selected}
          onSelect={setSelected}
          onRefresh={agents.refresh}
          loading={agents.loading}
          error={agents.error}
        />
      </AssistantDialog>
      <AssistantDialog
        isOpen={!!detail}
        label="Assistant permissions"
        onClose={() => setDetail(null)}
        closable={!savingAccess}
        width="1120px"
        maxWidth="96vw"
        height="min(850px, calc(100dvh - 32px))"
        maxHeight="calc(100dvh - 32px)"
        overflow="hidden"
      >
        {detail && (
          <AccessCopyProvider value={ASSISTANT_ACCESS_COPY}>
            <McpAccessEditor
              detail={detail}
              layout="dialog"
              onBusyChange={setSavingAccess}
              onClose={() => setDetail(null)}
              onSaved={() => {
                setDetail(null);
                automations.refresh();
              }}
            />
          </AccessCopyProvider>
        )}
      </AssistantDialog>
    </>
  );
}
