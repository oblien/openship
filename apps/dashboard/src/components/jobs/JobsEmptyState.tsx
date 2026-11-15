"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { FeatureIllustration } from "@repo/ui/illustrations";

import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

const DOCS_URL = "https://openship.io/docs";

export function JobsEmptyState({ onCreate }: { onCreate: () => void }) {
  const { t } = useI18n();
  const e = t.jobs.customEmpty;

  return (
    <div className="rounded-2xl bg-card px-6 py-10 text-center">
      <FeatureIllustration
        name="jobs-triggers"
        className="illustration-color mx-auto mb-4 h-auto w-20"
      />
      <h3 className="mb-2 text-xl font-medium tracking-tight text-foreground">{e.title}</h3>
      <p className="mx-auto mb-6 max-w-md text-sm leading-relaxed text-muted-foreground">
        {e.desc}
      </p>

      <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Button type="button" onClick={onCreate}>
          <UiIcon name="plus" aria-hidden="true" />
          {e.cta}
        </Button>
        <Button asChild variant="secondary">
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
            <UiIcon name="book" aria-hidden="true" />
            {e.docs}
            <UiIcon name="external-link" aria-hidden="true" />
          </a>
        </Button>
      </div>
    </div>
  );
}
