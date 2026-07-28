"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";

/**
 * Branded shell for the app's dead-end screens (crash boundary, API unreachable).
 *
 * Built in the same theme-variable language as `not-found-view.tsx` so all three
 * dead ends read as one family, and — unlike the bare centered text they replace —
 * it keeps the Openship brand mark and a way out (docs / GitHub), because these
 * are exactly the screens where a self-hoster is stuck and needs a next step.
 *
 * Callers own the full-height centering wrapper, matching NotFoundView.
 */

/** GitHub mark — inlined (lucide has no brand icons). */
function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.55v-1.94c-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.16.09 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.97.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.26 5.69.41.36.78 1.06.78 2.14v3.17c0 .3.2.66.8.55A11.5 11.5 0 0 0 23.5 12A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

/**
 * `crash` — a card that broke (unexpected render error).
 * `offline` — a link that doesn't reach (the API can't be contacted).
 */
export function ErrorIllustration({
  variant,
  className,
}: {
  variant: "crash" | "offline";
  className?: string;
}) {
  return (
    <div className={cn("relative mx-auto h-40 w-56", className)}>
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 240 180" fill="none" aria-hidden>
        {variant === "offline" ? (
          <>
            {/* Two halves of a severed connection: our box on the left, the
                unreachable service on the right, cable broken in the middle. */}
            <rect x="18" y="58" width="76" height="62" rx="10" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="2" />
            <rect x="30" y="72" width="52" height="6" rx="3" fill="var(--th-on-12)" />
            <rect x="30" y="86" width="34" height="6" rx="3" fill="var(--th-on-08)" />
            <circle cx="36" cy="106" r="3.5" fill="var(--th-on-15)" />

            <rect x="146" y="58" width="76" height="62" rx="10" fill="var(--th-sf-03)" stroke="var(--th-bd-default)" strokeWidth="2" strokeDasharray="6 5" />
            <rect x="158" y="72" width="52" height="6" rx="3" fill="var(--th-on-08)" />
            <rect x="158" y="86" width="34" height="6" rx="3" fill="var(--th-on-06)" />

            {/* Cable with a gap — the break */}
            <line x1="94" y1="89" x2="112" y2="89" stroke="var(--th-on-20)" strokeWidth="5" strokeLinecap="round" />
            <line x1="128" y1="89" x2="146" y2="89" stroke="var(--th-on-20)" strokeWidth="5" strokeLinecap="round" />
            <path d="M114 80l6 9-6 9" stroke="var(--th-on-15)" strokeWidth="2" strokeLinecap="round" fill="none" />
            <path d="M126 80l-6 9 6 9" stroke="var(--th-on-15)" strokeWidth="2" strokeLinecap="round" fill="none" />
          </>
        ) : (
          <>
            {/* A stacked card that cracked */}
            <rect x="52" y="46" width="136" height="86" rx="12" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1.5" />
            <rect x="40" y="58" width="136" height="86" rx="12" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="2" />
            <rect x="56" y="74" width="62" height="7" rx="3.5" fill="var(--th-on-12)" />
            <rect x="56" y="90" width="40" height="7" rx="3.5" fill="var(--th-on-08)" />
            {/* The crack */}
            <path
              d="M108 58l10 26-16 8 14 22-8 30"
              stroke="var(--th-on-25)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </>
        )}

        {/* Shared floating accents — same vocabulary as the 404 illustration. */}
        <circle cx="24" cy="34" r="4" fill="var(--th-on-10)" />
        <circle cx="212" cy="30" r="3.5" fill="var(--th-on-12)" />
        <circle cx="30" cy="150" r="5.5" fill="var(--th-on-08)" />
        <circle cx="206" cy="152" r="3" fill="var(--th-on-10)" />
        <path d="M14 92l2.5-5 2.5 5-5-2.5 5 0-5 2.5z" fill="var(--th-on-16)" />
        <path d="M224 96l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-12)" />
      </svg>
    </div>
  );
}

export interface ErrorAction {
  label: string;
  /** Link target. Omit and pass `onClick` for an in-place action (retry/reset). */
  href?: string;
  onClick?: () => void;
  icon?: ReactNode;
  variant?: "primary" | "secondary";
}

export function ErrorView({
  variant,
  brand,
  title,
  description,
  hints,
  code,
  codeLabel,
  actions,
  docsHref = "https://openship.io/docs",
  docsLabel,
  githubLabel,
}: {
  variant: "crash" | "offline";
  /** Product name for the brand lockup (localized by the caller). */
  brand: string;
  title: string;
  description: string;
  /** Optional "what to check" lines — rendered as a compact card. */
  hints?: ReactNode[];
  /** Error digest / correlation id. */
  code?: string;
  codeLabel?: string;
  actions: ErrorAction[];
  docsHref?: string;
  docsLabel: string;
  githubLabel: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center text-center">
      {/* Brand lockup — same as the auth shell, so a dead end still says where
          you are instead of dropping you on unbranded text. */}
      <div className="flex items-center gap-2.5">
        <Logo size={22} />
        <span className="text-[15px] font-semibold tracking-tight text-foreground">{brand}</span>
      </div>

      <ErrorIllustration variant={variant} className="mt-6" />

      <h1 className="mt-3 text-2xl font-medium tracking-tight text-foreground/85">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground/70">{description}</p>

      {hints && hints.length > 0 && (
        <ul className="mt-5 w-full space-y-2 rounded-xl border border-border/50 bg-muted/20 px-4 py-3.5 text-start">
          {hints.map((hint, i) => (
            <li key={i} className="flex gap-2.5 text-[13px] leading-relaxed text-muted-foreground">
              <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
              <span className="min-w-0">{hint}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-7 flex flex-col gap-3 sm:flex-row">
        {actions.map((action) =>
          action.href ? (
            <Link
              key={action.label}
              href={action.href}
              className={actionClass(action.variant)}
            >
              {action.icon}
              {action.label}
            </Link>
          ) : (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              className={actionClass(action.variant)}
            >
              {action.icon}
              {action.label}
            </button>
          ),
        )}
      </div>

      {code && (
        <p className="mt-6 font-mono text-[11px] text-muted-foreground/50">
          {codeLabel ? `${codeLabel} ` : ""}
          {code}
        </p>
      )}

      {/* Escape hatches. These screens are where a self-hoster is most stuck, so
          docs + the issue tracker are one click away. */}
      <div className="mt-6 flex items-center gap-5 text-xs text-muted-foreground/60">
        <a
          href={docsHref}
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-foreground"
        >
          {docsLabel}
        </a>
        <span aria-hidden className="size-1 rounded-full bg-muted-foreground/30" />
        <a
          href="https://github.com/oblien/openship/issues"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
        >
          <GitHubIcon className="size-3.5" />
          {githubLabel}
        </a>
      </div>
    </div>
  );
}

function actionClass(variant: ErrorAction["variant"]) {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium transition-colors",
    variant === "secondary"
      ? "bg-muted/50 text-foreground hover:bg-muted"
      : "bg-primary text-primary-foreground hover:bg-primary/90",
  );
}
