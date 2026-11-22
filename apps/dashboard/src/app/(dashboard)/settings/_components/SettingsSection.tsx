"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

import { useState } from "react";

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
  open: controlledOpen,
  onOpenChange,
}: {
  icon: IconName;
  title: string;
  description?: string;
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
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setOpen] = useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const expanded = collapsible ? open : true;

  const header = (
    <>
      <div className={`w-9 h-9 ${iconBg} rounded-xl flex items-center justify-center shrink-0`}>
        <UiIcon name={Icon} className={`size-[18px] ${iconColor}`} />
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold text-foreground text-[15px]">{title}</h2>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {collapsible && (
        <UiIcon name="chevron-down"
          className={`size-4 text-muted-foreground shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      )}
    </>
  );

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="flex flex-wrap items-center">
        {collapsible ? (
          <button
            type="button"
            onClick={() => (onOpenChange ?? setOpen)(!open)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-3 px-5 py-4 text-start"
          >
            {header}
          </button>
        ) : (
          <div className="flex min-w-0 flex-auto items-center gap-3 px-5 py-4">{header}</div>
        )}
        {action && <div className="ms-auto px-5 py-2">{action}</div>}
      </div>
      {expanded && <div className="border-t border-border/50 p-5">{children}</div>}
    </div>
  );
}
