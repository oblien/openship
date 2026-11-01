"use client";

import { Icon } from "@repo/ui/icons";
import { cn } from "@/lib/utils";

/** One token-creation destination for Library and GitHub credential forms. */
export function CreateGitHubTokenLink({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <a
      href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=Openship"
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
    >
      {label}
      <Icon name="arrow-up-right" className="size-3 shrink-0" />
    </a>
  );
}
