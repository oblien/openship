import type { ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";

export function DomainCell({ domain, href, children }: { domain: string; href?: string; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted/50">
        <Icon name="globe" className="size-4 text-muted-foreground" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground" title={domain}>
          {href ? <Link href={href} scroll={false} className="hover:underline"><bdi>{domain}</bdi></Link> : <bdi>{domain}</bdi>}
        </p>
        {children}
      </div>
    </div>
  );
}
