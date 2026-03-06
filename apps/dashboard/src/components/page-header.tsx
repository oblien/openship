"use client";

import { useI18n } from "@/components/i18n-provider";

/**
 * Shared dashboard page header.
 * Pass the i18n key for a page in `dashboard.pages.*`.
 */
export function PageHeader({ pageKey }: { pageKey: string }) {
  const { t } = useI18n();
  const page = (t.dashboard.pages as Record<string, { title: string; description: string }>)[pageKey];

  return (
    <div className="mb-8">
      <h1 className="text-xl font-semibold tracking-tight text-foreground">
        {page?.title ?? pageKey}
      </h1>
      {page?.description && (
        <p className="mt-1.5 text-sm text-muted-foreground">
          {page.description}
        </p>
      )}
    </div>
  );
}
