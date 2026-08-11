"use client";

import React from "react";
import { ChevronDown } from "lucide-react";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import { useI18n } from "@/components/i18n-provider";

interface DomainSwitcherProps {
  /** Candidate hostnames (project domains / per-service routes). */
  domains: string[];
  /** Currently selected hostname. Empty string means "all" when `allowAll` is set. */
  value: string;
  onChange: (hostname: string) => void;
  className?: string;
  /**
   * Offer an "All domains" entry, selected when `value` is empty.
   *
   * For a view that AGGREGATES across domains (the monitoring tab) rather than pointing
   * at one of them. Off by default because the original callers — the Overview URL card
   * and the logs header — each show a single domain's data, where "all" has no meaning.
   *
   * With this on, empty is a real selection rather than "fall back to the first domain",
   * which is why `current` is resolved differently below.
   */
  allowAll?: boolean;
}

/**
 * Shared domain selector used by the Overview URL card, the server-logs header and the
 * monitoring tab, so a multi-domain project switches the same way everywhere. With one
 * (or zero) domain it's just static text — no dropdown, no behavior change.
 */
export function DomainSwitcher({
  domains,
  value,
  onChange,
  className = "",
  allowAll = false,
}: DomainSwitcherProps) {
  const { t } = useI18n();
  const w = t.widgets.routing.domainSwitcher;
  const unique = Array.from(new Set(domains.filter(Boolean)));
  // Without allowAll, empty means "not chosen yet" and falls back to the first domain.
  // With it, empty is the All selection and must NOT be coerced to a hostname.
  const current = allowAll ? value : value || unique[0] || "";

  if (unique.length <= 1) {
    // One domain makes "all" and "that domain" the same set, so there is nothing to pick
    // between either way.
    return (
      <span className={`truncate text-sm font-medium text-foreground ${className}`}>
        {unique[0] || w.notConfigured}
      </span>
    );
  }

  const actions: MenuAction[] = [
    ...(allowAll
      ? [
          {
            id: "__all__",
            label: w.allDomains,
            onClick: () => onChange(""),
            variant: current === "" ? ("success" as const) : ("default" as const),
          },
        ]
      : []),
    ...unique.map((hostname) => ({
      id: hostname,
      label: hostname,
      onClick: () => onChange(hostname),
      variant: hostname === current ? ("success" as const) : ("default" as const),
    })),
  ];

  return (
    <DropdownMenu
      actions={actions}
      align="right"
      className={className}
      triggerClassName="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border/50 bg-muted/30 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
      trigger={
        <>
          <span className="truncate">
            {current || (allowAll ? w.allDomains : w.selectDomain)}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </>
      }
    />
  );
}

export default DomainSwitcher;
