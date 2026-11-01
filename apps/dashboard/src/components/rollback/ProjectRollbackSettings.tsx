"use client";

import { useI18n } from "@/components/i18n-provider";
import { RollbackRetentionCards } from "./RollbackRetentionCards";
import { useRollbackSettings } from "./useRollbackSettings";

export function ProjectRollbackSettings({ projectId, artifactKind }: {
  projectId: string;
  artifactKind: "image" | "files";
}) {
  const { t } = useI18n();
  const settings = useRollbackSettings(projectId);
  return (
    <>
      {settings.error && (
        <p role="alert" className="text-sm text-danger">
          {settings.error}{" "}
          <button type="button" className="underline" onClick={() => void settings.reload()}>
            {t.deployments.retry}
          </button>
        </p>
      )}
      <RollbackRetentionCards
        strategy={settings.capacity?.strategy === "snapshot" ? "snapshot" : "git"}
        capacity={settings.capacity}
        artifactKind={artifactKind}
        onToggleStrategy={settings.toggleStrategy}
        onChangeWindow={settings.changeWindow}
        savingWindow={settings.savingWindow}
        togglingStrategy={settings.togglingStrategy}
        readOnly={settings.loading || !settings.capacity}
      />
    </>
  );
}
