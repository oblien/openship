import React, { useState } from "react";
import { generateIcon } from "@/utils/icons";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { DeletionModal } from "./DeletionModal";
import { ResourceSettings } from "./ResourceSettings";
import { SleepModeSettings } from "./SleepModeSettings";
import { useToast } from "@/context/ToastContext";
import { projectsApi } from "@/lib/api";

interface Props {
  onDeleteProject: () => void;
}


export const AdvancedSettings = ({ onDeleteProject }: Props) => {
  const { showToast } = useToast();
  const { projectData } = useProjectSettings();
  const [isProjectActive, setIsProjectActive] = useState(projectData?.active ?? true);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const [loading, setLoading] = useState({
    disableProject: false,
    deleteProject: false,
    clearInstallCache: false,
    clearBuildCache: false,
  });
  

  const handleDisableProject = async () => {
    if (loading.disableProject) return;
    setLoading({ ...loading, disableProject: true });
    const response = await projectsApi.toggle(projectData.id, !isProjectActive);
   
    if (response.success) {
      setIsProjectActive(!isProjectActive);
      setLoading({ ...loading, disableProject: false });
    } else {
      showToast(response.message,'error', 'Failed to disable project');
      setLoading({ ...loading, disableProject: false });
    }
  };

  const handleClearInstallCache = async () => {
    if (loading.clearInstallCache) return;
    setLoading({ ...loading, clearInstallCache: true });
    const response = await projectsApi.clearCache(projectData.id);
    if (response.success) {
      setLoading({ ...loading, clearInstallCache: false });
    } else {
      showToast(response.message,'error', 'Failed to clear install cache');
      setLoading({ ...loading, clearInstallCache: false });
    }
  };

  const handleClearBuildCache = async () => {
    if (loading.clearBuildCache) return;
    setLoading({ ...loading, clearBuildCache: true });
    const response = await projectsApi.clearBuild(projectData.id);
    if (response.success) {
      setLoading({ ...loading, clearBuildCache: false });
    } else {
      showToast(response.message,'error', 'Failed to clear build cache');
      setLoading({ ...loading, clearBuildCache: false });
    }
  };

  return (
    <div className="space-y-6">
      {/* Project Status Control */}
      <div className="bg-card rounded-2xl border border-border/50 p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center border border-primary/20">

            {generateIcon('setting-100-1658432731.png', 24, 'hsl(var(--primary))')}
          </div>
          <h3 className="text-lg font-semibold text-foreground">Project Status</h3>
        </div>

        <div className="space-y-4">
          {/* Enable/Disable */}
          <div className="flex items-center justify-between p-4 bg-muted/60 rounded-xl hover:bg-muted transition-all">
            <div className="flex items-center gap-3">
              {isProjectActive ? (
                generateIcon('pause-279-1658234823.png', 24, 'rgb(16, 185, 129)')
              ) : (
                generateIcon('play-287-1658234823.png', 24, 'rgb(245, 158, 11)')
              )}
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {isProjectActive ? 'Project Active' : 'Project Disabled'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {isProjectActive ? 'Project is live and accessible' : 'Project is paused and not accessible'}
                </p>
              </div>
            </div>
            <button
              onClick={handleDisableProject}
              disabled={loading.disableProject}
              className={`px-5 py-2.5 rounded-full font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-all ${isProjectActive
                ? 'bg-amber-500 hover:bg-amber-600 text-white'
                : 'bg-foreground hover:bg-foreground/80 text-background'
                }`}
            >
              {isProjectActive ? 'Disable' : 'Enable'}
            </button>
          </div>

          {/* Visibility */}
          {/* <div className="flex items-center justify-between p-4 bg-muted/60 rounded-xl hover:bg-muted transition-all">
            <div className="flex items-center gap-3">
              {isProjectPublic ? (
                <Eye className="w-5 h-5 text-primary" />
              ) : (
                <EyeOff className="w-5 h-5 text-muted-foreground" />
              )}
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {isProjectPublic ? 'Public Project' : 'Private Project'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {isProjectPublic ? 'Visible in public listings' : 'Hidden from public view'}
                </p>
              </div>
            </div>
            <button
              onClick={handleToggleVisibility}
              className="px-5 py-2.5 rounded-full bg-muted/60 hover:bg-muted text-foreground font-medium text-sm transition-all"
            >
              {isProjectPublic ? 'Make Private' : 'Make Public'}
            </button>
          </div> */}
        </div>
      </div>

      {/* Machine Power */}
      <ResourceSettings 
        projectId={projectData?.id} 
        currentResources={projectData?.resources} 
      />

      {/* Container Mode */}
      <SleepModeSettings 
        projectId={projectData?.id} 
        currentMode={projectData?.sleep_mode} 
      />

      {/* Security Settings */}
      <div className="bg-card rounded-2xl border border-border/50 p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center border border-primary/20">
            {generateIcon('record%20circle-69-1663753435.png', 24, 'hsl(var(--primary))')}
          </div>

          <h3 className="text-lg font-semibold text-foreground">Cache</h3>
        </div>

        <div className="flex items-center gap-4 ">
          <button onClick={handleClearInstallCache} disabled={loading.clearInstallCache} className="w-full flex items-center justify-between p-4 bg-muted/60 hover:bg-muted rounded-xl transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed">
            <div className="flex items-center gap-3">
              {generateIcon('npm-184-1693375161.png', 20, 'hsl(var(--primary))')}
              <div>
                <p className="text-sm font-semibold text-foreground">Clear Install Cache</p>
                <p className="text-xs text-muted-foreground">Clear the node_modules cache for the project</p>
              </div>
            </div>
          </button>

          <button onClick={handleClearBuildCache} disabled={loading.clearBuildCache} className="w-full flex items-center justify-between p-4 bg-muted/60 hover:bg-muted rounded-xl transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed">
            <div className="flex items-center gap-3">
              {generateIcon('tools-118-1658432731.png', 24, 'hsl(var(--primary))')}
              <div>
                <p className="text-sm font-semibold text-foreground">Clear Build Cache</p>
                <p className="text-xs text-muted-foreground">Remove all cached build files</p>
              </div>
            </div>
          </button>
        </div>
      </div>

      {/* Danger Zone - Delete */}
      <div className="bg-red-500/5 rounded-2xl border border-red-500/20 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-red-500/10 rounded-xl flex items-center justify-center border border-red-500/20">
            {generateIcon('fire-82-1689139787.png', 24, 'rgb(239, 68, 68)')}
          </div>
          <h3 className="text-lg font-semibold text-red-600 dark:text-red-400">Danger Zone</h3>
        </div>

        <div className="mb-5">
          <h4 className="text-base font-semibold text-red-600 dark:text-red-400 mb-2">
            Delete This Project
          </h4>
          <p className="text-sm text-red-800/80 leading-relaxed mb-4">
            Once you delete a project, there is no going back. This action will permanently remove:
          </p>
          <ul className="space-y-2 text-sm text-red-800/80 mb-6">
            <li className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-red-600 rounded-full"></div>
              All deployments and deployment history
            </li>
            <li className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-red-600 rounded-full"></div>
              Custom domains and DNS configurations
            </li>
            <li className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-red-600 rounded-full"></div>
              Environment variables and secrets
            </li>
            <li className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-red-600 rounded-full"></div>
              All project data and analytics
            </li>
          </ul>
        </div>

        <button
          onClick={() => setShowDeleteModal(true)}
          className="inline-flex items-center gap-2 bg-red-600 text-white hover:bg-red-700 font-medium px-6 py-3 rounded-full transition-all hover:shadow-md"
        >
          {generateIcon('delete-24-1692683695.png', 24, 'white')}
          Delete Project Permanently
        </button>
      </div>
      <DeletionModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={onDeleteProject}
        projectName={projectData?.name || projectData?.domain}
      />
    </div>
  );
};


