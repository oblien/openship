"use client";

import { useEffect, useId, useRef } from "react";
import Link from "next/link";
import { Icon, type IconName } from "@repo/ui/icons";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";

/** Shared completion screen for confirmed account actions. */
export function AuthSuccess({
  icon,
  title,
  description,
  actionLabel,
  actionHref,
  email,
}: {
  icon: IconName;
  title: string;
  description: string;
  actionLabel: string;
  actionHref: string;
  /** The account confirmed by the completed request, never a URL-only hint. */
  email?: string | null;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);

  return (
    <AuthShell maxWidth="max-w-[440px]">
      <section
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        className="rounded-3xl bg-card px-6 py-8 text-center sm:p-9"
      >
        <div aria-hidden="true" className="relative mx-auto mb-7 flex h-28 w-40 items-center justify-center">
          <div className="absolute size-28 rounded-full bg-success/5" />
          <div className="absolute size-20 -rotate-12 rounded-3xl bg-success/10" />
          <div className="relative flex size-20 items-center justify-center rounded-3xl bg-background text-foreground">
            <Icon name={icon} className="size-8" />
            <span className="absolute -bottom-1 -end-2 flex size-9 items-center justify-center rounded-full bg-[var(--th-card-bg-solid)]">
              <span className="flex size-7 items-center justify-center rounded-full bg-success/15 text-success">
                <Icon name="check" className="size-4" />
              </span>
            </span>
          </div>
        </div>

        <h1
          id={`${id}-title`}
          ref={heading}
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight text-foreground outline-none"
        >
          {title}
        </h1>
        <p id={`${id}-description`} className="mx-auto mt-3 max-w-xs text-sm leading-6 text-muted-foreground">
          {description}
        </p>

        {email && (
          <div className="mt-5">
            <p className="inline-flex max-w-full items-center gap-2 rounded-xl bg-muted/40 px-3.5 py-2.5 text-sm text-foreground">
              <Icon name="mail" className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <bdi dir="ltr" className="min-w-0 break-all">{email}</bdi>
            </p>
          </div>
        )}

        <Button asChild className="mt-8 h-11 w-full">
          <Link href={actionHref}>
            {actionLabel}
            <Icon name="arrow-right" className="size-4 rtl:rotate-180" aria-hidden="true" />
          </Link>
        </Button>
      </section>
    </AuthShell>
  );
}
