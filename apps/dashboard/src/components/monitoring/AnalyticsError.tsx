"use client";

import { interpolate, useI18n } from "@/components/i18n-provider";
import { ConnectionNotice } from "@/components/shared/ConnectionNotice";

/** Shared by Overview and Monitoring; unrelated resource/geo data stays visible. */
export function AnalyticsError({
  error,
  onRetry,
  title,
  sections,
  hasData = false,
  retrying = false,
}: {
  error: string;
  onRetry?: () => void;
  title?: string;
  sections?: string[];
  hasData?: boolean;
  retrying?: boolean;
}) {
  const { t } = useI18n();
  const message = sections?.length
    ? interpolate(t.projects.analytics.sectionsUnavailable, { sections: sections.join(", ") })
    : t.projects.analytics.loadFailedDescription;
  return (
    <ConnectionNotice
      role="alert"
      title={title ?? t.projects.analytics.loadFailed}
      message={hasData ? `${message} ${t.projects.analytics.staleData}` : message}
      detail={error}
      onRetry={onRetry}
      retrying={retrying}
      retryLabel={t.projects.services.retry}
    />
  );
}
