"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared "resource not found" state for detail pages (server, project,
 * deployment, backup…). One centered, theme-correct shell so every vector
 * reads the same: a resource icon, a title + description, an optional copyable
 * id chip, and href/onClick actions. `children` hosts any per-resource extras
 * (e.g. the project page's reasons list + help links). RTL-correct.
 */
export interface ResourceNotFoundAction {
  label: ReactNode;
  icon?: ReactNode;
  variant?: "primary" | "secondary";
  /** A link target… */
  href?: string;
  /** …or an imperative handler (router.push, reload). One of the two. */
  onClick?: () => void;
}

export function ResourceNotFound({
  icon,
  title,
  description,
  detail,
  detailCopyLabel,
  actions,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  detail?: string;
  detailCopyLabel?: string;
  actions: ResourceNotFoundAction[];
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center text-center">
      <div className="mb-5 flex size-16 items-center justify-center rounded-2xl border border-border/50 bg-muted/50 text-muted-foreground">
        {icon}
      </div>
      <h1 className="text-xl font-semibold text-foreground/90">{title}</h1>
      {description ? (
        <p className="mx-auto mt-2 max-w-sm break-words text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
      {detail ? <IdChip value={detail} copyLabel={detailCopyLabel} /> : null}
      {children}
      {actions.length > 0 ? (
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          {actions.map((action, i) => (
            <ActionButton key={i} action={action} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Only navigate for an internal ("/…", not protocol-relative "//") or explicit
// http(s) href — so a future dynamic caller can't smuggle a javascript:/data:
// URL through Next <Link>. Every current caller passes a constant; this is
// defense-in-depth. An unsafe href falls back to a non-navigating button.
const SAFE_HREF = /^(\/(?!\/)|https?:\/\/)/i;

function ActionButton({ action }: { action: ResourceNotFoundAction }) {
  const className = cn(
    "inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium transition-colors",
    action.variant === "secondary"
      ? "bg-muted/50 text-foreground hover:bg-muted"
      : "bg-primary text-primary-foreground hover:bg-primary/90",
  );
  if (action.href && SAFE_HREF.test(action.href)) {
    return (
      <Link href={action.href} className={className}>
        {action.icon}
        {action.label}
      </Link>
    );
  }
  return (
    <button type="button" onClick={action.onClick} className={className}>
      {action.icon}
      {action.label}
    </button>
  );
}

/** Monospace id with click-to-copy. Copy is guarded — it no-ops (never throws)
 *  when the Clipboard API is unavailable (insecure context / old browser). */
function IdChip({ value, copyLabel }: { value: string; copyLabel?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const p = navigator.clipboard?.writeText?.(value);
    if (!p) return;
    p.then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={copyLabel}
      aria-label={copyLabel}
      className="group mt-3 inline-flex max-w-full items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted/70"
    >
      <span className="truncate">{value}</span>
      {copied ? (
        <UiIcon name="check" className="size-3.5 shrink-0 text-success" />
      ) : (
        <UiIcon name="copy" className="size-3.5 shrink-0 opacity-60 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  );
}
