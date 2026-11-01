"use client";

import { useI18n } from "@/components/i18n-provider";
import type { ServerInfo } from "@/lib/api/system";
import { ServerPicker, ServerRowContent } from "@/components/shared/ServerPicker";

/** One compact destination selector; choices live in the shared accessible menu. */
export function CloudSpaceSelector({
  spaces,
  selected,
  onSelect,
}: {
  spaces: ServerInfo[];
  selected: string;
  onSelect?: (id: string) => void;
}) {
  const { t } = useI18n();
  const copy = t.servers.resources;
  const current = spaces.find((space) => space.id === selected);
  return (
    <section
      aria-label={copy.space}
      className="min-w-0 rounded-2xl bg-card p-5 @min-[64rem]/resources:col-start-2 @min-[64rem]/resources:row-start-1"
    >
      <h2 className="mb-3 text-xs text-muted-foreground">{copy.space}</h2>
      {spaces.length > 1 && onSelect ? (
        <ServerPicker
          servers={spaces}
          selectedId={selected}
          onSelect={(space) => onSelect(space.id)}
          label={copy.selectPool}
          showLabel={false}
          details="plan"
          showStatus
        />
      ) : current ? (
        <div className="flex min-w-0 items-center gap-2.5">
          <ServerRowContent server={current} active details="plan" showStatus />
        </div>
      ) : null}
    </section>
  );
}
