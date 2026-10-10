"use client";
import { Icon } from "@repo/ui/icons";
import type { ActionWorkflowNotifications } from "@repo/core";
import { notificationsApi } from "@/lib/api/notifications";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ChannelLogo } from "@/components/ui/ChannelLogo";
import { useActionResource } from "./useActions";
import { ActionError } from "./ActionStatus";

export function WorkflowChecks({
  repository,
  github,
  projectScoped,
  value,
  onChange,
}: {
  repository: boolean;
  github: boolean;
  projectScoped: boolean;
  value: ActionWorkflowNotifications | null;
  onChange: (value: ActionWorkflowNotifications) => void;
}) {
  const { t } = useI18n();
  const c = t.actions.completion;
  const channels = useActionResource(notificationsApi.listChannels);
  const config = value ?? { channels: [], events: ["failure"] };
  const hidden = config.channels.filter(
    (id) => !channels.data?.channels.some((channel) => channel.id === id),
  );
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Icon
            name={repository ? "github" : "check-circle"}
            className="size-5 text-muted-foreground"
          />
          <h2 className="text-sm font-medium">{repository ? c.githubChecks : c.runResults}</h2>
          <span className="ms-auto rounded-md bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
            {c.automatic}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {repository ? (github ? c.githubChecksHint : c.appChecksHint) : c.standaloneChecksHint}
        </p>
        {projectScoped && (
          <p className="text-xs leading-relaxed text-muted-foreground">{c.requiredChecksHint}</p>
        )}
      </section>
      <section className="space-y-4 border-t border-border/40 pt-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Icon name="bell" className="size-4 text-muted-foreground" />
            {c.notifications}
          </h2>
          <span className="text-xs text-muted-foreground">{c.optional}</span>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{c.notificationsHint}</p>
        <div role="group" aria-label={c.notifyWhen} className="flex flex-wrap gap-x-4 gap-y-3">
          {(["failure", "success", "cancelled"] as const).map((event) => (
            <label key={event} className="flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox
                checked={config.events.includes(event)}
                onCheckedChange={(checked) =>
                  onChange({
                    ...config,
                    events: checked
                      ? [...config.events, event]
                      : config.events.filter((item) => item !== event),
                  })
                }
              />
              {c.events[event]}
            </label>
          ))}
        </div>
        <ActionError message={channels.error} onRetry={channels.refresh} />
        {channels.loading && !channels.data && (
          <div aria-busy="true" className="h-24 animate-pulse rounded-xl bg-background" />
        )}
        <div className="space-y-2" role="group" aria-label={c.channels}>
          {channels.data?.channels.map((channel) => (
            <label
              key={channel.id}
              className={`flex items-center gap-3 rounded-xl bg-background px-3 py-3 ${channel.enabled && channel.verified ? "cursor-pointer" : "text-muted-foreground"}`}
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
                      ? [...config.channels, channel.id]
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
          ))}
          {channels.data && !channels.data.channels.length && (
            <p className="rounded-xl bg-background p-3 text-xs leading-relaxed text-muted-foreground">
              {c.noChannels}
            </p>
          )}
        </div>
        {!!hidden.length && channels.data && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {interpolate(c.teamChannels, { count: String(hidden.length) })}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <Button asChild variant="ghost" size="sm" className="-ms-2">
            <a href="/settings?tab=notifications" target="_blank" rel="noopener noreferrer">
              {c.manageChannels}
              <Icon name="external-link" className="size-3.5" />
            </a>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={channels.refresh}
            aria-label={t.actions.refresh}
          >
            <Icon name="refresh" />
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{c.accountPreferences}</p>
      </section>
    </div>
  );
}
