"use client";

import { RELEASE_RECIPE_VERSION } from "@repo/core";
import { recipeSummaryLines, type MountedReleaseConfigUI } from "./release-recipe";

export function ReleaseRecipeSummary({
  config,
  compact,
}: {
  config: MountedReleaseConfigUI | null | undefined;
  compact?: boolean;
}) {
  if (!config?.enabled) return null;
  const summary = recipeSummaryLines(config);
  return (
    <div
      className={
        compact
          ? "rounded-xl border border-border/40 bg-muted/20 px-4 py-3"
          : "rounded-xl border border-border/40 bg-muted/15 px-4 py-3"
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Recipe v{RELEASE_RECIPE_VERSION}
        </p>
        {summary.presetLabel ? (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
            {summary.presetLabel}
          </span>
        ) : null}
        {config.serviceName ? (
          <span className="text-[11px] text-muted-foreground">{config.serviceName}</span>
        ) : null}
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {summary.lines.map((line) => (
          <li key={line} className="text-[12px] text-foreground">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}
