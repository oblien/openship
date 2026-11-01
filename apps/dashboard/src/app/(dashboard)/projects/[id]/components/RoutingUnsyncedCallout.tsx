"use client";

/** Show the persisted routing failure beside the domain cards and their repair action. */

import React from "react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n } from "@/components/i18n-provider";
import WarningCallout from "@/components/shared/WarningCallout";
import { localizeDiagnosisMessage } from "@/lib/i18n/localize-issues";

export const RoutingUnsyncedCallout = ({
  onRetry,
  retrying = false,
}: {
  onRetry: () => void;
  retrying?: boolean;
}) => {
  const { projectData } = useProjectSettings();
  const { t } = useI18n();

  // A pending partial-failure decision outranks this: that release hasn't been
  // accepted yet, so its routes aren't the thing to fix first.
  // The inline operation owns progress while running. Keep the saved failure
  // until the server refreshes it, but don't display that stale result mid-repair.
  if (retrying || !projectData?.routingUnsynced || projectData.awaitingDecision)
    return null;

  const warning = projectData?.routingWarning
    ? localizeDiagnosisMessage(projectData.routingWarning, t.issues?.messages)
    : t.projects.routingRetry.description;

  return (
    <WarningCallout
      title={t.projects.routingRetry.title}
      description={warning}
      actions={
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg bg-warning-solid px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-warning-solid/90 disabled:opacity-60"
        >
          {t.projects.routingRetry.retry}
        </button>
      }
    />
  );
};

export default RoutingUnsyncedCallout;
