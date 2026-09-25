"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useI18n } from "@/components/i18n-provider";
import type { RunEventsState } from "@/hooks/useRunEvents";

export function NetworkStreamNotice({ stream }: { stream: RunEventsState }) {
  const { t } = useI18n();
  const m = t.servers.networks.managed;
  if (!stream.reconnecting && !stream.error) return null;
  return (
    <div
      role="status"
      className="my-5 flex flex-wrap items-center gap-3 rounded-xl bg-muted/50 p-4 text-sm text-muted-foreground"
    >
      {stream.reconnecting ? (
        <UiIcon name="spinner" className="size-4 shrink-0 animate-spin" />
      ) : (
        <UiIcon name="wifi-off" className="size-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1">
        {stream.reconnecting ? m.liveReconnecting : stream.error?.message || m.liveDisconnected}
      </span>
      <button type="button" className="shrink-0 underline" onClick={stream.reconnect}>
        {m.reconnect}
      </button>
    </div>
  );
}
