"use client";

import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { FeatureIllustration } from "@repo/ui/illustrations";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

/** Compact first-project welcome inside the home page's Projects card. */
export default function HomeWelcome() {
  const { t } = useI18n();
  const copy = t.overview.welcome;

  return (
    <div className="px-6 py-8 text-center">
      <FeatureIllustration
        name="any-stack"
        className="illustration-soft mx-auto mb-5 h-auto w-20"
      />
      <h3 className="mb-2 text-xl font-medium tracking-tight text-foreground">{copy.title}</h3>
      <p className="mx-auto mb-5 max-w-sm text-sm leading-relaxed text-muted-foreground">
        {copy.subtitle}
      </p>

      <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Button asChild className="px-5">
          <Link href="/library">
            <Icon name="plus" className="size-4" />
            {copy.createProject}
          </Link>
        </Button>
        <Button asChild variant="secondary" className="px-5">
          <Link href="/library">
            <Icon name="github" className="size-4" />
            {copy.importGithub}
          </Link>
        </Button>
      </div>

      <p className="mt-5 text-xs text-muted-foreground">
        {copy.tipPrefix}{" "}
        <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘ K</kbd>{" "}
        {copy.tipSuffix}
      </p>
    </div>
  );
}
