"use client";

import { useState } from "react";
import { Icon } from "@repo/ui/icons";
import type { ActionWorkflowNotifications } from "@repo/core";
import { notificationsApi, type NotificationChannel } from "@/lib/api/notifications";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ChannelLogo } from "@/components/ui/ChannelLogo";
import { useActionResource, useActionScope } from "./useActions";
import { ActionError } from "./ActionStatus";
import { WorkflowChannelDialog } from "./WorkflowChannelDialog";
import { WorkflowRepositoryChecks } from "./WorkflowRepositoryChecks";

interface WorkflowChecksProps {
  repository: string | null;
  github: boolean;
  independent: boolean;
  value: ActionWorkflowNotifications | null;
  onChange: (value: ActionWorkflowNotifications) => void;
}

export function WorkflowChecks(props: WorkflowChecksProps) {
  const scope = useActionScope();
  return <ScopedWorkflowChecks key={scope} {...props} />;
}

function ScopedWorkflowChecks({
  repository,
  github,
  independent,
  value,
  onChange,
}: WorkflowChecksProps) {
  const { t } = useI18n();
  const c = t.actions.completion;
  const channels = useActionResource(notificationsApi.listChannels);
  const [setup, setSetup] = useState<NotificationChannel | "new" | null>(null);
  const [created, setCreated] = useState<{
    baseline: typeof channels.data;
    channels: NotificationChannel[];
  } | null>(null);
  // Mutation receipts bridge the refresh only. A later server response owns
  // enabled/verified state, including changes made outside this dialog.
  const pendingChannels = created?.baseline === channels.data ? created.channels : [];
  const available = [...(channels.data?.channels ?? [])];
  for (const channel of pendingChannels) {
    const index = available.findIndex((item) => item.id === channel.id);
    if (index < 0) available.push(channel);
    else if (channel.verified) available[index] = channel;
  }
  const config = value ?? { channels: [], events: ["failure"] };
  const hidden = config.channels.filter((id) => !available.some((channel) => channel.id === id));
  const createdChannel = (channel: NotificationChannel) => {
    setCreated((current) => ({
      baseline: channels.data,
      channels: [
        ...(current?.baseline === channels.data ? current.channels : []).filter(
          (item) => item.id !== channel.id,
        ),
        channel,
      ],
    }));
    channels.refresh();
  };
  const add = (
    <Button variant="secondary" size="sm" onClick={() => setSetup("new")}>
      <Icon name="plus" className="size-3.5" />
      {c.addChannel}
    </Button>
  );
  return (
    <div className="space-y-5">
      {repository ? (
        <>
          {github && (
            <WorkflowRepositoryChecks key={`${repository}:github`} repository={repository} github />
          )}
          {independent && (
            <WorkflowRepositoryChecks
              key={`${repository}:openship`}
              repository={repository}
              github={false}
            />
          )}
        </>
      ) : (
        <section className="flex items-center gap-3 rounded-xl bg-background p-3.5">
          <Icon name="check-circle" className="size-5 shrink-0 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-medium">{c.runResults}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{c.standaloneChecksHint}</p>
          </div>
        </section>
      )}
      <section className="space-y-4 border-t border-border/40 pt-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Icon name="bell" className="size-4 text-muted-foreground" />
            {c.notifications}
          </h2>
          {available.length > 0 ? (
            add
          ) : (
            <span className="text-xs text-muted-foreground">{c.optional}</span>
          )}
        </div>
        <ActionError message={channels.error} onRetry={channels.refresh} />
        {channels.loading && !channels.data && !pendingChannels.length && (
          <div aria-busy="true" className="h-16 animate-pulse rounded-xl bg-background" />
        )}
        {(channels.data || pendingChannels.length > 0) && !available.length && (
          <div className="space-y-3 rounded-xl bg-background p-4">
            <p className="text-xs text-muted-foreground">{c.noChannels}</p>
            {add}
          </div>
        )}
        <div className="space-y-2" role="group" aria-label={c.channels}>
          {available.map((channel) => (
            <div
              key={channel.id}
              className="flex items-center gap-2 rounded-xl bg-background px-3 py-3"
            >
              <label
                className={`flex min-w-0 flex-1 items-center gap-3 ${channel.enabled && channel.verified ? "cursor-pointer" : "text-muted-foreground"}`}
              >
                <Checkbox
                  checked={config.channels.includes(channel.id)}
                  disabled={
                    (!channel.enabled || !channel.verified) && !config.channels.includes(channel.id)
                  }
                  onCheckedChange={(checked) =>
                    onChange({
                      ...config,
                      channels: checked
                        ? [...new Set([...config.channels, channel.id])]
                        : config.channels.filter((id) => id !== channel.id),
                    })
                  }
                />
                <ChannelLogo kind={channel.kind} className="size-5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{channel.label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {!channel.enabled
                      ? c.channelDisabled
                      : !channel.verified
                        ? c.verifyChannel
                        : t.settings.notifications.kinds[channel.kind]}
                  </span>
                </span>
              </label>
              {channel.enabled && !channel.verified && (
                <Button variant="ghost" size="sm" onClick={() => setSetup(channel)}>
                  {c.verify}
                </Button>
              )}
            </div>
          ))}
        </div>
        {available.length > 0 && (
          <div className="space-y-2.5" role="group" aria-label={c.notifyWhen}>
            <p className="text-xs font-medium text-muted-foreground">{c.notifyWhen}</p>
            <div className="flex flex-wrap gap-2">
              {(["failure", "success", "cancelled"] as const).map((event) => (
                <label
                  key={event}
                  className="flex cursor-pointer items-center gap-2 rounded-lg bg-background px-2.5 py-2 text-xs"
                >
                  <Checkbox
                    checked={config.events.includes(event)}
                    onCheckedChange={(checked) =>
                      onChange({
                        ...config,
                        events: checked
                          ? [...new Set([...config.events, event])]
                          : config.events.filter((item) => item !== event),
                      })
                    }
                  />
                  {c.events[event]}
                </label>
              ))}
            </div>
          </div>
        )}
        {!!hidden.length && channels.data && (
          <p className="text-xs text-muted-foreground">
            {interpolate(c.teamChannels, { count: String(hidden.length) })}
          </p>
        )}
      </section>
      {setup && (
        <WorkflowChannelDialog
          channel={setup === "new" ? undefined : setup}
          onClose={() => {
            setSetup(null);
            channels.refresh();
          }}
          onCreated={createdChannel}
          onUse={(channel) => {
            createdChannel(channel);
            onChange({ ...config, channels: [...new Set([...config.channels, channel.id])] });
            setSetup(null);
          }}
        />
      )}
    </div>
  );
}
