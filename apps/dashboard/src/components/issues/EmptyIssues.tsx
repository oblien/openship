"use client";

import { Icon } from "@repo/ui/icons";
import { FeatureIllustration } from "@repo/ui/illustrations";

import { useI18n } from "@/components/i18n-provider";

/** Empty incidents, history and search results are distinct states, not health verdicts. */
export function EmptyIssues({ filtered, resolved }: { filtered: boolean; resolved: boolean }) {
  const { t } = useI18n();
  const c = t.issues.empty;

  const variant = filtered ? "filtered" : resolved ? "resolved" : "open";
  const [title, body] =
    variant === "filtered"
      ? [c.filteredTitle, c.filteredBody]
      : variant === "resolved"
        ? [c.resolvedTitle, c.resolvedBody]
        : [c.openTitle, c.openBody];

  return (
    <div className="rounded-2xl bg-card px-6 py-10 text-center">
      {variant === "filtered" ? (
        <Icon
          name="search"
          className="mx-auto mb-4 size-8 text-muted-foreground"
          aria-hidden="true"
        />
      ) : (
        <FeatureIllustration
          name={variant === "resolved" ? "jobs-triggers" : "logs-monitoring"}
          className="illustration-color mx-auto mb-4 h-auto w-20"
        />
      )}
      <h3 className="text-base font-medium tracking-tight text-foreground">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}
