"use client";

import { Icon } from "@repo/ui/icons";
import { cn } from "@/lib/utils";

// Both providers support prefilling the token name and requested scopes.
const tokenUrls = {
  github: "https://github.com/settings/tokens/new?scopes=repo,read:org&description=OpenShip",
  gitlab:
    "https://gitlab.com/-/user_settings/personal_access_tokens?name=OpenShip&scopes=read_api,read_repository",
};
export function CreateGitTokenLink({
  provider,
  label,
  className,
}: {
  provider: keyof typeof tokenUrls;
  label: string;
  className?: string;
}) {
  return (
    <a
      href={tokenUrls[provider]}
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
