"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

export function SettingsSection({
  icon: Icon,
  title,
  description,
  children,
  action,
  iconBg = "bg-primary/10",
  iconColor = "text-primary",
  collapsible = false,
  defaultOpen = false,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  children: React.ReactNode;
  /**
   * Right-aligned control in the header — for the section's one primary action,
   * where a button parked at the bottom of a growing list drifts away from the
   * thing it acts on. Rendered as a sibling of the collapsible trigger, never
   * inside it: a button within a button is invalid and swallows the click.
   */
  action?: React.ReactNode;
  iconBg?: string;
  iconColor?: string;
  /** Render the section collapsed behind an expand toggle (header stays visible). */
  collapsible?: boolean;
  /** Initial open state when collapsible. Ignored for non-collapsible sections. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expanded = collapsible ? open : true;

  const header = (
    <>
      <div className={`w-9 h-9 ${iconBg} rounded-xl flex items-center justify-center shrink-0`}>
        <Icon className={`size-[18px] ${iconColor}`} />
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold text-foreground text-[15px]">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {collapsible && (
        <ChevronDown
          className={`size-4 text-muted-foreground shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      )}
    </>
  );

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      {/* The rule belongs to the header ROW, so the trigger can stay flex-1 and the
          action sit beside it without either owning the section's divider. */}
      <div className={`flex items-center ${expanded ? "border-b border-border/50" : ""}`}>
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-3 px-5 py-4 text-start"
          >
            {header}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3 px-5 py-4">{header}</div>
        )}
        {action && <div className="shrink-0 ps-3 pe-5">{action}</div>}
      </div>
      {expanded && <div className="p-5">{children}</div>}
    </div>
  );
}
