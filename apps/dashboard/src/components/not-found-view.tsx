import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 404 illustration — a "searched, found nothing" magnifying glass with 404 in
 * the lens. Deliberately NOT the card-stack used by the empty states (so a
 * not-found reads as its own thing), but built in the same theme-variable
 * language so it's correct in light + dark and fits the design system.
 */
export function NotFoundIllustration({ className }: { className?: string }) {
  return (
    <div className={cn("relative mx-auto h-48 w-60", className)}>
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 240 200" fill="none" aria-hidden>
        {/* Handle */}
        <line
          x1="150"
          y1="128"
          x2="190"
          y2="170"
          stroke="var(--th-on-20)"
          strokeWidth="14"
          strokeLinecap="round"
        />
        <line
          x1="150"
          y1="128"
          x2="190"
          y2="170"
          stroke="var(--th-on-10)"
          strokeWidth="6"
          strokeLinecap="round"
        />

        {/* Lens */}
        <circle cx="104" cy="90" r="58" fill="var(--th-sf-04)" />
        <circle cx="104" cy="90" r="52" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="2" />
        {/* Dashed inner ring — the "empty result" */}
        <circle cx="104" cy="90" r="40" fill="none" stroke="var(--th-on-15)" strokeWidth="1.5" strokeDasharray="5 5" />
        {/* Glass sheen */}
        <path d="M78 66a36 36 0 0 1 26-14" stroke="var(--th-on-12)" strokeWidth="3" strokeLinecap="round" fill="none" />

        {/* 404 in the lens */}
        <text
          x="104"
          y="101"
          textAnchor="middle"
          fill="var(--th-on-30)"
          fontSize="32"
          fontWeight="700"
          letterSpacing="1"
          style={{ fontFamily: "inherit" }}
        >
          404
        </text>

        {/* Floating dots */}
        <circle cx="30" cy="52" r="4" fill="var(--th-on-10)" />
        <circle cx="46" cy="150" r="6" fill="var(--th-on-08)" />
        <circle cx="196" cy="44" r="3.5" fill="var(--th-on-12)" />
        <circle cx="176" cy="96" r="3" fill="var(--th-on-10)" />

        {/* Sparkle accents */}
        <path d="M24 96l2.5-5 2.5 5-5-2.5 5 0-5 2.5z" fill="var(--th-on-16)" />
        <path d="M206 150l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-12)" />
      </svg>
    </div>
  );
}

export interface NotFoundAction {
  href: string;
  label: string;
  icon?: ReactNode;
  variant?: "primary" | "secondary";
}

/**
 * Clean, centered 404 body. The CALLER is responsible for the full-height
 * centering wrapper (so it sits dead-center in whatever chrome hosts it —
 * the sidebar shell or the branded AuthShell).
 */
export function NotFoundView({
  title = "Page not found",
  description = "The page you're looking for doesn't exist or has moved.",
  actions,
}: {
  title?: string;
  description?: string;
  actions: NotFoundAction[];
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center text-center">
      <NotFoundIllustration />
      <h1 className="mt-4 text-2xl font-medium tracking-tight text-foreground/85">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        {actions.map((action) => (
          <Link
            key={action.href + action.label}
            href={action.href}
            className={cn(
              "inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium transition-colors",
              action.variant === "secondary"
                ? "bg-muted/50 text-foreground hover:bg-muted"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {action.icon}
            {action.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
