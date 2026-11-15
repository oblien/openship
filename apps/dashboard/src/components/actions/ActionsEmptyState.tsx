import type { ReactNode } from "react";
import { FeatureIllustration, type FeatureIllustrationName } from "@repo/ui/illustrations";

const illustrations = {
  workflow: "actions-ci",
  runner: "runner-destinations",
  history: "audit-log",
} satisfies Record<string, FeatureIllustrationName>;

export function ActionsEmptyState({
  kind = "workflow",
  title,
  description,
  compact = false,
  children,
}: {
  kind?: "workflow" | "runner" | "history";
  title: string;
  description: string;
  compact?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col items-center rounded-2xl bg-card px-6 text-center ${compact ? "py-7" : "py-10 sm:py-12"}`}
    >
      <FeatureIllustration
        name={illustrations[kind]}
        className={`illustration-color h-auto ${compact ? "w-16" : "w-20"}`}
      />
      <h2
        className={`mt-4 font-medium tracking-tight text-foreground ${compact ? "text-base" : "text-xl"}`}
      >
        {title}
      </h2>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
      {children && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">{children}</div>
      )}
    </div>
  );
}
