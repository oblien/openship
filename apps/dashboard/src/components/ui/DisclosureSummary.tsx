import type { ComponentProps } from "react";
import { Icon } from "@repo/ui/icons";
import { cn } from "@/lib/utils";

/** Branded disclosure control; the parent <details> owns native keyboard and open behavior. */
export function DisclosureSummary({ children, className, ...props }: ComponentProps<"summary">) {
  return (
    <summary
      {...props}
      className={cn(
        "disclosure-summary flex cursor-pointer list-none items-center gap-2 rounded-md py-1 text-start transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none [&::-webkit-details-marker]:hidden",
        className,
      )}
    >
      <Icon
        name="chevron-down"
        aria-hidden="true"
        className="disclosure-chevron size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none"
      />
      <span className="min-w-0">{children}</span>
    </summary>
  );
}
