"use client";

import React from "react";

export interface TabDef<K extends string = string> {
  key: K;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** When true the tab is not rendered (e.g. Backup only for stateful services). */
  hidden?: boolean;
  /**
   * Deep-link target. When set the tab renders as an <a> so the URL is
   * shareable and cmd/ctrl-click opens a new tab; a plain click is still
   * intercepted and handed to `onChange` for an instant client-side switch.
   * Without it the tab is a plain button (local view state).
   */
  href?: string;
}

interface TabsProps<K extends string> {
  tabs: TabDef<K>[];
  value: K;
  onChange: (key: K) => void;
  className?: string;
}

/**
 * Underline tab strip — the shared version of the pattern hand-rolled across
 * billing, the servers detail page, and the project logs view (border-b strip,
 * `px-4 py-2.5` items, `bg-primary` active underline). Controlled: the caller
 * owns the active `value`.
 */
export function Tabs<K extends string>({ tabs, value, onChange, className = "" }: TabsProps<K>) {
  return (
    <div className={`flex items-center gap-1 overflow-x-auto border-b border-border/50 scrollbar-hide ${className}`}>
      {tabs
        .filter((tab) => !tab.hidden)
        .map(({ key, label, icon: Icon, href }) => {
          const active = key === value;
          const className = `relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-2.5 text-sm font-medium transition-colors ${
            active ? "text-foreground" : "text-muted-foreground hover:text-foreground/70"
          }`;
          const inner = (
            <>
              {Icon && <Icon className="size-4" />}
              {label}
              {active && (
                <span className="absolute bottom-0 start-0 end-0 h-0.5 rounded-full bg-primary" />
              )}
            </>
          );
          return href ? (
            <a
              key={key}
              href={href}
              className={className}
              onClick={(e) => {
                // Let the browser handle modified clicks (new tab / window);
                // intercept a plain click for an instant client-side switch.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                onChange(key);
              }}
            >
              {inner}
            </a>
          ) : (
            <button key={key} type="button" onClick={() => onChange(key)} className={className}>
              {inner}
            </button>
          );
        })}
    </div>
  );
}

export default Tabs;
