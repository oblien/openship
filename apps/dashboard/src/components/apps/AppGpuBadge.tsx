"use client";

import { useI18n } from "@/components/i18n-provider";
import type { AppTemplate } from "@repo/core";

export function AppGpuBadge({ gpu }: { gpu?: AppTemplate["gpu"] }) {
  const { t } = useI18n();
  if (!gpu) return null;
  const copy = t.dashboard.pages.apps.gpu;
  return (
    <span className="inline-block max-w-full truncate rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
      {gpu === "required" ? copy.required : copy.recommended}
    </span>
  );
}
