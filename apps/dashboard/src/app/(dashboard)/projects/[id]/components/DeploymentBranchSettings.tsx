"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Icon as UiIcon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { RepositoryBranchSelect } from "@/components/github/RepositoryBranchSelect";
import { Button } from "@/components/ui/button";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { projectEnvironmentIds } from "@/context/project-environments";
import { useToast } from "@/context/ToastContext";
import { invalidateProjectCachesFor } from "@/hooks/useProjectEndpoints";
import { projectsApi } from "@/lib/api/projects";
import { getApiErrorMessage } from "@/lib/api/client";

/** Updates the selected environment through the existing project branch operation. */
export function DeploymentBranchSettings() {
  const {
    id,
    projectData,
    gitData,
    environments = [],
    updateProjectData,
    refreshGit,
  } = useProjectSettings();
  const { showToast } = useToast();
  const { t } = useI18n();
  const copy = t.projectSettings.git.branch;
  const inputId = useId();
  const [branch, setBranch] = useState(gitData.branch || "main");
  const [savedBranch, setSavedBranch] = useState(gitData.branch || "main");
  const [saving, setSaving] = useState(false);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    const value = gitData.branch || "main";
    setBranch(value);
    setSavedBranch(value);
  }, [gitData.branch]);

  const save = async () => {
    if (saving || !branch || branch === savedBranch) return;
    setSaving(true);
    try {
      const result = await projectsApi.setBranch(id, branch);
      invalidateProjectCachesFor(projectEnvironmentIds(id, environments));
      // The Source editor remounts per environment. A late save must not update
      // the newly selected environment or its toast/commit list.
      if (!active.current) return;
      setBranch(result.branch);
      setSavedBranch(result.branch);
      updateProjectData({ gitBranch: result.branch, branch: result.branch });
      showToast(copy.saved, "success");
      await refreshGit();
    } catch (error) {
      if (active.current) showToast(getApiErrorMessage(error, copy.saveFailed), "error");
    } finally {
      if (active.current) setSaving(false);
    }
  };

  return (
    <form
      className="mt-4 rounded-xl bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label htmlFor={inputId} className="text-sm font-medium text-foreground">
        {copy.label}
      </label>
      <div className="mt-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <RepositoryBranchSelect
            id={inputId}
            projectId={id}
            owner={projectData.gitOwner || ""}
            repo={projectData.gitRepo || ""}
            value={branch}
            onChange={setBranch}
            disabled={saving}
          />
        </div>
        <Button type="submit" disabled={saving || !branch || branch === savedBranch}>
          {saving && <UiIcon name="spinner" className="animate-spin" />}
          {saving ? t.projectSettings.appSettings.saving : t.projectSettings.settingSection.save}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{copy.description}</p>
    </form>
  );
}
