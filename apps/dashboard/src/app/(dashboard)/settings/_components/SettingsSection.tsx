"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

export function SettingsSection({
  icon: Icon,
  title,
  description,
  children,
  iconBg = "bg-primary/10",
  iconColor = "text-primary",
  collapsible = false,
  defaultOpen = false,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  children: React.ReactNode;
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
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={`w-full flex items-center gap-3 px-5 py-4 text-start ${
            expanded ? "border-b border-border/50" : ""
          }`}
        >
          {header}
        </button>
      ) : (
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">{header}</div>
      )}
      {expanded && <div className="p-5">{children}</div>}
    </div>
  );
}
