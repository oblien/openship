"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

/**
 * Standard card with a header (icon + title + optional description) and
 * an optional right-side action slot. Use this everywhere instead of
 * hand-rolling the same div-tree per file - it's how we keep the admin
 * panel visually consistent with the rest of the dashboard.
 *
 * Two density modes:
 *   - "soft"  (default): single padded card, inline header at top, body
 *                        rendered inside the same padding. Matches
 *                        DashboardHomeClient's right-rail cards.
 *   - "split"          : header has its own padding + bottom border,
 *                        body is unpadded (caller renders rows that
 *                        run edge-to-edge - used for tables/lists).
 */

import { cn } from "@/lib/utils";

interface SectionCardProps {
  title: string;
  description?: string;
  icon?: IconName;
  action?: React.ReactNode;
  density?: "soft" | "split";
  className?: string;
  children: React.ReactNode;
}

export function SectionCard({
  title,
  description,
  icon: Icon,
  action,
  density = "soft",
  className,
  children,
}: SectionCardProps) {
  if (density === "split") {
    return (
      <div
        className={cn(
          "bg-card rounded-2xl border border-border/50 overflow-hidden",
          className,
        )}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border/50">
          <div className="flex items-center gap-2.5 min-w-0">
            {Icon && (
              <UiIcon name={Icon}
                className="size-4 text-muted-foreground shrink-0"
              />
            )}
            <div className="min-w-0">
              <h3 className="font-semibold text-foreground text-sm truncate">
                {title}
              </h3>
              {description && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {description}
                </p>
              )}
            </div>
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
        <div>{children}</div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "bg-card rounded-2xl border border-border/50 p-5",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && (
            <UiIcon name={Icon}
              className="size-4 text-muted-foreground shrink-0"
            />
          )}
          <h3 className="font-semibold text-foreground text-sm truncate">
            {title}
          </h3>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {description && (
        <p className="text-sm text-muted-foreground leading-relaxed -mt-3 mb-4">
          {description}
        </p>
      )}
      {children}
    </div>
  );
}
