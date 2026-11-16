"use client";

import { useId } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { FeatureIllustration, type FeatureIllustrationName } from "@repo/ui/illustrations";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { DisclosureSummary } from "@/components/ui/DisclosureSummary";
import { useI18n } from "@/components/i18n-provider";

type ErrorType = "repo-not-found" | "project-not-found" | "access-denied" | "load-failed";

interface ErrorStateProps {
  type?: ErrorType;
  error?: {
    message?: string;
    details?: string;
  };
  onRetry?: () => void;
  retrying?: boolean;
}

const illustrations = {
  "repo-not-found": "git-authentication",
  "project-not-found": "local-folder-deploys",
  "access-denied": "private-networking",
  "load-failed": "api-sdk",
} satisfies Record<ErrorType, FeatureIllustrationName>;

/** Resource failures share the same quiet, illustrated layout as empty lists. */
export default function ErrorState({
  error = {},
  type = "repo-not-found",
  onRetry,
  retrying = false,
}: ErrorStateProps) {
  const { t } = useI18n();
  const w = t.widgets.shared.errorState;
  const titleId = useId();
  const descriptionId = useId();
  const configs = {
    "repo-not-found": w.repoNotFound,
    "project-not-found": w.projectNotFound,
    "access-denied": w.accessDenied,
    "load-failed": { ...w.loadFailed, hints: [] },
  };
  const config = configs[type];
  const canRetry = type === "load-failed" && !!onRetry;
  const destination = type === "repo-not-found" ? "/library" : "/projects";
  const destinationLabel =
    type === "repo-not-found" ? w.repoNotFound.backToLibrary : t.chrome.error.goToProjects;

  return (
    <PageContainer className="flex min-h-[70svh] items-center justify-center">
      <section
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="w-full max-w-md py-10 text-center"
      >
        <FeatureIllustration
          name={illustrations[type]}
          className="illustration-color mx-auto h-auto w-20"
        />
        <div role="status" aria-live="polite" className="mt-5">
          <h1 id={titleId} className="text-2xl font-medium tracking-tight text-foreground">
            {error.message || config.title}
          </h1>
          <p id={descriptionId} className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {config.subtitle}
          </p>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {canRetry && (
            <Button type="button" onClick={onRetry} disabled={retrying} aria-busy={retrying}>
              <Icon
                name={retrying ? "spinner" : "refresh"}
                className={retrying ? "motion-safe:animate-spin" : undefined}
                aria-hidden="true"
              />
              {t.chrome.error.tryAgain}
            </Button>
          )}
          <Button asChild variant={canRetry ? "secondary" : "default"}>
            <Link href={destination}>{destinationLabel}</Link>
          </Button>
          {type === "project-not-found" && (
            <Button asChild variant="secondary">
              <Link href="/library">
                <Icon name="plus" aria-hidden="true" />
                {w.projectNotFound.createNewProject}
              </Link>
            </Button>
          )}
        </div>

        {(error.details || config.hints.length > 0) && (
          <details className="mt-6 text-start text-sm text-muted-foreground">
            <DisclosureSummary className="mx-auto w-fit">
              {error.details ? t.issues.connectivity.details : w.commonCauses}
            </DisclosureSummary>
            <div className="mt-3 space-y-3 rounded-xl bg-card p-4 text-xs leading-relaxed">
              {error.details && (
                <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {error.details}
                </p>
              )}
              {config.hints.length > 0 && (
                <ul className="space-y-2">
                  {config.hints.map((hint) => (
                    <li key={hint} className="flex items-start gap-2">
                      <span
                        aria-hidden="true"
                        className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/40"
                      />
                      {hint}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        )}

        <a
          href="https://openship.io/docs"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 inline-flex items-center gap-1.5 rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {w.documentation}
          <Icon name="external-link" size={14} aria-hidden="true" />
        </a>
      </section>
    </PageContainer>
  );
}
