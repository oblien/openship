"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

/**
 * Shared callout — the app's standard "amber" warning treatment, extracted from
 * the server detail page's ConnectionBanner so every warning across the product
 * looks identical (theme-aware, dark-mode safe, semantic tones).
 *
 * Use for inline warnings AND inside modals. Compose extra content via children
 * (e.g. a "suggested fix" list) and an actions row via `actions`.
 *
 * (Distinct from the legacy `AlertBox`, which uses hardcoded light-only colors
 * and does not match the design system — prefer this.)
 */
import React from "react";

type CalloutTone = "warning" | "danger" | "info";

interface WarningCalloutProps {
  /** Visual tone. Defaults to the amber "warning" treatment. */
  tone?: CalloutTone;
  title: string;
  /** Optional body copy under the title. */
  description?: React.ReactNode;
  /** Override the leading icon (defaults to AlertTriangle). */
  icon?: IconName;
  /** Extra content rendered under the description (lists, sub-cards, etc.). */
  children?: React.ReactNode;
  /** Buttons/links rendered in a wrapping row at the bottom. */
  actions?: React.ReactNode;
  className?: string;
}

const TONES: Record<CalloutTone, { container: string; iconBox: string }> = {
  warning: {
    container: "bg-warning-bg border-warning-border",
    iconBox: "bg-warning-bg text-warning",
  },
  danger: {
    container: "bg-danger-bg border-danger-border",
    iconBox: "bg-danger-bg text-danger",
  },
  info: {
    container: "bg-primary/[0.06] border-primary/25",
    iconBox: "bg-primary/10 text-primary",
  },
};

export function WarningCallout({
  tone = "warning",
  title,
  description,
  icon,
  children,
  actions,
  className = "",
}: WarningCalloutProps) {
  const t = TONES[tone];
  const Icon = icon ?? "warning";

  return (
    <div className={`rounded-2xl border p-4 ${t.container} ${className}`}>
      <div className="flex items-start gap-3">
        <div className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${t.iconBox}`}>
          <UiIcon name={Icon} className="size-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {description && (
            <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">{description}</p>
          )}
          {children}
          {actions && <div className="flex items-center gap-2 mt-3 flex-wrap">{actions}</div>}
        </div>
      </div>
    </div>
  );
}

export default WarningCallout;
