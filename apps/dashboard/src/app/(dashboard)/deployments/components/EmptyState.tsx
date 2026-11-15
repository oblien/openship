"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { FeatureIllustration } from "@repo/ui/illustrations";

import React from "react";
import Link from "next/link";
import { useI18n } from "@/components/i18n-provider";

interface EmptyStateProps {
  hasFilters: boolean;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ hasFilters }) => {
  const { t } = useI18n();
  if (hasFilters) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-16 text-center">
        <div className="max-w-md mx-auto">
          <div className="w-16 h-16 bg-muted/60 rounded-full flex items-center justify-center mx-auto mb-4 border border-border/50">
            <UiIcon name="search-x" className="w-7 h-7 text-muted-foreground/50" />
          </div>
          <h3 className="text-lg font-medium text-foreground/80 mb-2">{t.deployments.empty.filtered.title}</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t.deployments.empty.filtered.description}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-2xl px-6 py-10 text-center">
      <FeatureIllustration
        name="push-to-deploy"
        className="illustration-color mx-auto mb-6 h-auto w-20"
      />

      <h3 className="text-lg font-medium text-foreground/80 mb-2">
        {t.deployments.empty.none.title}
      </h3>
      <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-8 leading-relaxed">
        {t.deployments.empty.none.description}
      </p>

      <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
        <Link
          href="/library"
          className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5"
        >
          <UiIcon name="plus" className="size-4" />
          {t.deployments.empty.none.deployButton}
        </Link>
        <Link
          href="/library"
          className="inline-flex items-center gap-2 px-6 py-3 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors"
        >
          <UiIcon name="git-branch" className="size-4" />
          {t.deployments.empty.none.browseButton}
        </Link>
      </div>
    </div>
  );
};

