"use client";

import { useI18n, interpolate } from "@/components/i18n-provider";
import type { RunEventsState } from "@/hooks/useRunEvents";

export function BackupStreamNotice({ stream }: { stream: RunEventsState }) {
  const { t } = useI18n();
  const w = t.widgets.backup.runCard;
  if (!stream.reconnecting && !stream.error) return null;
  return (
    <div
      role="status"
      className="mt-3 flex items-center gap-3 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground"
    >
      <span className="min-w-0 flex-1 break-words">
        {stream.reconnecting
          ? w.reconnecting
          : interpolate(w.streamError, { message: stream.error?.message ?? "" })}
      </span>
      <button type="button" className="shrink-0 underline" onClick={stream.reconnect}>
        {w.reconnect}
      </button>
    </div>
  );
}
