"use client";

import React from "react";
import { ChevronDown } from "lucide-react";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import { useI18n } from "@/components/i18n-provider";

interface DomainSwitcherProps {
  /** Candidate hostnames (project domains / per-service routes). */
  domains: string[];
  /** Currently selected hostname. */
  value: string;
  onChange: (hostname: string) => void;
  className?: string;
}

/**
 * Shared domain selector used by the Overview URL card and the server-logs
 * header so a multi-domain project switches the same way everywhere. With one
 * (or zero) domain it's just static text — no dropdown, no behavior change.
 */
export function DomainSwitcher({ domains, value, onChange, className = "" }: DomainSwitcherProps) {
  const { t } = useI18n();
  const w = t.widgets.routing.domainSwitcher;
  const unique = Array.from(new Set(domains.filter(Boolean)));
  const current = value || unique[0] || "";

  if (unique.length <= 1) {
    return (
      <span className={`truncate text-sm font-medium text-foreground ${className}`}>
        {current || w.notConfigured}
      </span>
    );
  }

  const actions: MenuAction[] = unique.map((hostname) => ({
    id: hostname,
    label: hostname,
    onClick: () => onChange(hostname),
    variant: hostname === current ? "success" : "default",
  }));

  return (
    <DropdownMenu
      actions={actions}
      align="right"
      className={className}
      triggerClassName="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border/50 bg-muted/30 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
      trigger={
        <>
          <span className="truncate">{current || w.selectDomain}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </>
      }
    />
  );
}

export default DomainSwitcher;
