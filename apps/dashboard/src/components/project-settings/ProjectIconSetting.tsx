"use client";

import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n } from "@/components/i18n-provider";
import { ImageUrlEditor } from "@/components/settings/ImageUrlEditor";
import { projectsApi } from "@/lib/api";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";

export function ProjectIconSetting({ onClose }: { onClose: () => void }) {
  const { projectData, updateProjectData } = useProjectSettings();
  const { t } = useI18n();
  const c = t.projectSettings.icon;
  return (
    <ImageUrlEditor
      key={projectData.id}
      onClose={onClose}
      value={projectData.iconUrl}
      editLabel={c.change}
      label={c.label}
      hint={c.hint}
      resetLabel={c.reset}
      fallback={
        <ProjectIcon
          project={{
            ...projectData,
            iconUrl: null,
          }}
          appTemplateId={projectData.appTemplateId}
          className="size-5"
        />
      }
      onSave={async (iconUrl) => {
        const response = await projectsApi.update(projectData.id, { iconUrl });
        updateProjectData({ iconUrl: response.data.iconUrl });
        invalidateProjectCaches(projectData.id);
      }}
    />
  );
}
