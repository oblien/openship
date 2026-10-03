"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useI18n, interpolate } from "@/components/i18n-provider";
import type { DiscoveredStack } from "@/lib/api";

/** Discovery belongs in the review step, including routes we could not match. */
export function MigrationProxyReview({ stack }: { stack: DiscoveredStack }) {
  const { t } = useI18n();
  const copy = t.migration.wizard.edgeReview;
  const warnings = [...new Set(stack.warnings)];
  if (!stack.proxy && warnings.length === 0 && !stack.alreadyManaged) return null;

  return (
    <details className="group rounded-xl bg-card px-4 py-3 text-sm">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 rounded-lg text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <UiIcon
          name={warnings.length ? "warning" : "globe"}
          className={`size-4 shrink-0 ${warnings.length ? "text-warning" : ""}`}
        />
        <span className="min-w-0 flex-1 font-medium text-foreground">
          {stack.proxy
            ? interpolate(copy.detected, {
                proxy: stack.proxy.ours ? "Openship" : stack.proxy.kind,
              })
            : warnings.length
              ? interpolate(copy.warnings, { count: String(warnings.length) })
              : interpolate(t.migration.reimport.alreadyManaged, {
                  n: String(stack.alreadyManaged),
                })}
        </span>
        {stack.proxy && warnings.length > 0 && (
          <span
            className="rounded-md bg-warning-bg px-1.5 text-xs text-warning"
            aria-label={interpolate(copy.warnings, { count: String(warnings.length) })}
            title={interpolate(copy.warnings, { count: String(warnings.length) })}
          >
            {warnings.length}
          </span>
        )}
        <UiIcon
          name="chevron-down"
          className="size-4 shrink-0 transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="mt-3 space-y-3 text-xs text-muted-foreground">
        {stack.proxy && <p>{copy.handoff}</p>}
        {stack.alreadyManaged > 0 && (
          <p>
            {interpolate(t.migration.reimport.alreadyManaged, { n: String(stack.alreadyManaged) })}
          </p>
        )}
        {warnings.length > 0 && (
          <ul className="list-disc space-y-1.5 ps-5">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
