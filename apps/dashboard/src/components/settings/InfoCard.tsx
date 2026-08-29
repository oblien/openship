"use client";

import React from "react";

/**
 * One labelled setting row: icon, title, current value, explanation, and an
 * optional control on the right.
 *
 * Lifted out of GitSettings so any surface can render a setting in the same
 * shape — the deploy wizard's target panel shows the rollback retention controls
 * with this, instead of a second visual copy drifting from the settings tab.
 */
export function InfoCard({
  icon: Icon,
  title,
  value,
  description,
  action,
  footer,
  tone = "neutral",
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  value: string;
  description: string;
  action?: React.ReactNode;
  /** Optional full-width content below the row (e.g. a delivery-domain picker). */
  footer?: React.ReactNode;
  tone?: "neutral" | "success";
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone === "success" ? "bg-success-bg text-success" : "bg-primary/10 text-primary"}`}>
            <Icon className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground">{title}</p>
            <p className="mt-1 text-[13px] font-semibold text-foreground">{value}</p>
            <p className="mt-1 text-[12px] text-muted-foreground">{description}</p>
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {footer ? <div className="mt-3 border-t border-border/40 pt-3">{footer}</div> : null}
    </div>
  );
}

export default InfoCard;
