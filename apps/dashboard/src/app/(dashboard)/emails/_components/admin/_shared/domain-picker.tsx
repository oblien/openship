"use client";

/**
 * "Domain: <picker>" toolbar shared by every domain-scoped tab (Mailboxes,
 * Aliases, DNS). One component so the three cannot drift, and so all three use
 * the dashboard's own CustomSelect rather than a native <select> — a native one
 * renders the OS widget, which ignores the theme entirely.
 *
 * Children render after the picker; pass `ms-auto` on them for right-aligned
 * meta (counts, flags).
 */

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { CustomSelect } from "@/components/ui/CustomSelect";

export function DomainPicker({
  label,
  value,
  domains,
  onChange,
  loading,
  loadingLabel,
  children,
}: {
  label: string;
  value: string;
  domains: string[];
  onChange: (domain: string) => void;
  loading?: boolean;
  loadingLabel: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 flex-wrap">
      <span className="text-sm text-muted-foreground">{label}</span>
      {loading ? (
        <div className="inline-flex items-center gap-2 rounded-2xl border border-border/50 bg-muted/40 px-4 py-3">
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{loadingLabel}</span>
        </div>
      ) : (
        <CustomSelect
          className="min-w-[220px] max-w-[320px]"
          value={value}
          options={domains.map((d) => ({ value: d, label: d }))}
          onChange={onChange}
        />
      )}
      {children}
    </div>
  );
}
