"use client";

/**
 * Status pill - small rounded badge with a consistent tone palette.
 *
 * Used in every list (active/disabled mailbox, running/failed daemon,
 * primary domain, postmaster mailbox flag, etc.). One file = one source
 * of truth so we don't get five subtly different shades of "active green"
 * scattered across the admin panel.
 *
 * Shape is the dashboard's own badge: a tinted fill carrying the tone's text
 * colour, and NOTHING else. No outline (the tint already separates it from the
 * row, and a hairline around a 20px pill reads as a hard border on dark, which
 * is the same reason cards went borderless), and no leading dot (the fill is
 * already the colour the dot would repeat).
 *
 * Tones:
 *   - success   : "active", "running", "healthy" - emerald
 *   - warning   : "starting", "stopping", "missing" - amber
 *   - danger    : "failed" - red
 *   - info      : "primary", "postmaster", "soft-delete pending" - blue
 *   - neutral   : "disabled", "stopped", "unknown" - muted
 */

import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

export type PillTone = "success" | "warning" | "danger" | "info" | "neutral";

const TONE_CLASSES: Record<PillTone, string> = {
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
  info: "bg-info-bg text-info",
  neutral: "bg-foreground/[0.06] text-muted-foreground",
};

interface StatusPillProps {
  tone: PillTone;
  icon?: LucideIcon;
  children: React.ReactNode;
  className?: string;
}

export function StatusPill({ tone, icon: Icon, children, className }: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {Icon && <Icon className="size-3" strokeWidth={2} />}
      {children}
    </span>
  );
}
