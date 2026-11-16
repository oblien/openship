"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ComposeChanges, ComposeReview, ComposeServiceDiff } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { getApiErrorMessage } from "@/lib/api/client";

export type ComposeReviewDetails = Partial<ComposeReview>;

export function composeReviewDetails(error: unknown): ComposeReviewDetails | null {
  const e = error as { code?: string; body?: ComposeReviewDetails & { code?: string } } | null;
  if ((e?.body?.code ?? e?.code) !== "COMPOSE_REVIEW_REQUIRED") return null;
  return e?.body ?? {};
}

export function ComposeChangeSummary({ changes }: { changes?: ComposeChanges }) {
  const { t } = useI18n();
  const copy = t.projects.redeploy.composeReview;
  if (!changes) return null;
  return (
    <dl className="space-y-2 text-sm">
      {(["added", "changed", "removed"] as const).map((kind) =>
        changes[kind]?.length ? (
          <div key={kind} className="flex gap-3">
            <dt className="min-w-20 shrink-0 font-medium text-foreground">{copy[kind]}</dt>
            <dd className="min-w-0 flex-1 break-words text-muted-foreground">
              {changes[kind].join(", ")}
            </dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}

function ServiceDiff({ service }: { service: ComposeServiceDiff }) {
  const { t } = useI18n();
  const copy = t.projects.redeploy.composeReview;
  return (
    <section className="overflow-hidden rounded-2xl bg-card" aria-label={service.name}>
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <h3 className="min-w-0 break-all text-sm font-medium text-foreground">{service.name}</h3>
        <span className="shrink-0 text-xs text-muted-foreground">{copy[service.kind]}</span>
      </div>
      <div
        className="mx-5 mb-5 overflow-hidden rounded-xl bg-background/60 font-mono text-xs leading-6"
        dir="ltr"
      >
        {service.fields.map((field) => (
          <div key={field.path} className="border-t border-border/40 first:border-0">
            <div className="px-4 py-2 text-muted-foreground">{field.path}</div>
            {field.before !== null && (
              <div className="flex gap-3 bg-danger-bg px-4 py-1.5 text-danger">
                <span className="select-none" aria-hidden="true">
                  −
                </span>
                <span className="sr-only">{copy.before}: </span>
                <pre className="min-w-0 whitespace-pre-wrap break-all font-inherit">
                  {field.before}
                </pre>
              </div>
            )}
            {field.after !== null && (
              <div className="flex gap-3 bg-success-bg px-4 py-1.5 text-success">
                <span className="select-none" aria-hidden="true">
                  +
                </span>
                <span className="sr-only">{copy.after}: </span>
                <pre className="min-w-0 whitespace-pre-wrap break-all font-inherit">
                  {field.after}
                </pre>
              </div>
            )}
          </div>
        ))}
        {!service.fields.length && (
          <p className="px-4 py-3 font-sans text-muted-foreground">{copy.settingsChanged}</p>
        )}
      </div>
    </section>
  );
}

export function ComposeReviewDialog({
  review: initial,
  onApply,
  onConfigure,
  onClose,
}: {
  review: ComposeReviewDetails;
  onApply?: (revision: string) => Promise<unknown>;
  onConfigure: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const copy = t.projects.redeploy.composeReview;
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const [review, setReview] = useState(initial);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [changedAgain, setChangedAgain] = useState(false);
  const canApply = onApply && /^[a-f0-9]{64}$/.test(review.composeRevision ?? "");
  const apply = async () => {
    if (!canApply || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    setChangedAgain(false);
    try {
      const result = await onApply(review.composeRevision!);
      if (result === false || result === null) throw new Error(copy.applyFailed);
      onClose();
    } catch (cause) {
      const next = composeReviewDetails(cause);
      if (next && next.projectId === review.projectId) {
        setReview(next);
        setChangedAgain(true);
      } else setError(getApiErrorMessage(cause, copy.applyFailed));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) {
          event.stopPropagation();
          onClose();
        }
        if (event.key !== "Tab") return;
        const buttons =
          dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
        const first = buttons?.[0],
          last = buttons?.[buttons.length - 1];
        if (!first) {
          event.preventDefault();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === dialogRef.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      aria-busy={pending}
      className="flex max-h-[calc(100dvh-2rem)] flex-col text-foreground outline-none"
    >
      <header className="shrink-0 px-5 pb-5 pt-6 sm:px-8 sm:pt-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={headingId} className="text-xl font-semibold tracking-tight sm:text-2xl">
              {copy.title}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {copy.description}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            disabled={pending}
            onClick={onClose}
            aria-label={copy.cancel}
          >
            <Icon name="close" aria-hidden="true" />
          </Button>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          {(["changed", "added", "removed"] as const).map((kind) =>
            review.composeChanges?.[kind]?.length ? (
              <span key={kind}>
                <span className="me-1.5 font-medium text-foreground">
                  {review.composeChanges[kind].length}
                </span>
                {copy[kind]}
              </span>
            ) : null,
          )}
          <span className="ms-auto">{copy.secretsHidden}</span>
        </div>
      </header>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-5 pb-6 sm:px-8">
        {changedAgain && (
          <p role="status" className="mb-4 rounded-xl bg-warning-bg p-4 text-sm text-warning">
            {copy.changedAgain}
          </p>
        )}
        <div className="space-y-4">
          {review.composeDiff?.length ? (
            review.composeDiff.map((service) => (
              <ServiceDiff key={service.name} service={service} />
            ))
          ) : (
            <ComposeChangeSummary changes={review.composeChanges} />
          )}
        </div>
        {error && (
          <p role="alert" className="mt-4 rounded-xl bg-danger-bg p-4 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
      <footer className="shrink-0 border-t border-border/50 px-5 py-5 sm:px-8">
        <p className="mb-5 text-xs leading-relaxed text-muted-foreground">
          {copy.preservationHint}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" className="me-auto" disabled={pending} onClick={onClose}>
            {copy.cancel}
          </Button>
          <Button variant="secondary" disabled={pending} onClick={onConfigure}>
            {copy.configure}
          </Button>
          {canApply && (
            <Button disabled={pending} onClick={() => void apply()}>
              {pending ? copy.applying : copy.apply}
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}
