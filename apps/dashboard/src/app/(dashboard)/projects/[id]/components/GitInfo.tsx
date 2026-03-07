import React, { useState } from "react";
import { Github, GitCommit, Zap, GitBranch, Check, X } from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { projectsApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import generateIcon from "@/utils/icons";
import { formatDate } from "@/utils/date";

export const GitInfo = () => {
  const { projectData, id, updateProjectData } = useProjectSettings();
  const { showToast } = useToast();
  
  const [isEditingBranch, setIsEditingBranch] = useState(false);
  const [tempBranch, setTempBranch] = useState(projectData?.branch || 'main');
  const [branches, setBranches] = useState<string[]>([]);
  const [loadingBranch, setLoadingBranch] = useState(false);
  const [loadingAutoDeploy, setLoadingAutoDeploy] = useState(false);

  const handleEditBranch = async () => {
    if (!projectData?.id) return;

    setLoadingBranch(true);
    try {
      // Fetch available branches
      const response = await projectsApi.getBranches(projectData.id);
      if (response.success) {
        setBranches(response.branches || []);
        setIsEditingBranch(true);
        setTempBranch(projectData.branch || 'main');
      } else {
        showToast('Failed to fetch branches', 'error', 'Error');
      }
    } catch (error) {
      console.error('Error fetching branches:', error);
      showToast('Failed to fetch branches', 'error', 'Error');
    } finally {
      setLoadingBranch(false);
    }
  };

  const handleSaveBranch = async () => {
    if (!projectData?.id) return;

    setLoadingBranch(true);
    try {
      const response = await projectsApi.setBranch(projectData.id, tempBranch);
      if (response.success) {
        setIsEditingBranch(false);
        showToast('Branch updated successfully', 'success', 'Updated');
        // You might need to refresh project data here
      } else {
        showToast(response.message || 'Failed to update branch', 'error', 'Error');
      }
    } catch (error) {
      console.error('Error updating branch:', error);
      showToast('Failed to update branch', 'error', 'Error');
    } finally {
      setLoadingBranch(false);
    }
  };

  const handleCancelBranch = () => {
    setIsEditingBranch(false);
    setTempBranch(projectData?.branch || 'main');
  };

  const handleAutoDeployToggle = async () => {
    if (!projectData?.id) return;

    setLoadingAutoDeploy(true);
    try {
      const newAutoDeployState = !projectData.auto_deploy;
      const response = await projectsApi.gitSwitch(projectData.id, newAutoDeployState);
      
      if (response.success) {
        showToast(
          newAutoDeployState ? 'Auto-deploy enabled' : 'Auto-deploy disabled', 
          'success', 
          'Updated'
        );
        updateProjectData({ auto_deploy: newAutoDeployState });
      } else {
        showToast(response.message || 'Failed to update auto-deploy', 'error', 'Error');
      }
    } catch (error) {
      console.error('Error updating auto-deploy:', error);
      showToast('Failed to update auto-deploy', 'error', 'Error');
    } finally {
      setLoadingAutoDeploy(false);
    }
  };

  return (
    <div className="lg:sticky lg:top-6 h-fit space-y-4">
      {/* Git Repository Card */}
      <div className="bg-white rounded-[20px] border border-black/5 p-5">
        <div className="flex items-center gap-3 mb-5">
          {generateIcon('https://upload.wikimedia.org/wikipedia/commons/9/91/Octicons-mark-github.svg', 24, 'white', {}, true)}
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-base text-black truncate">{projectData?.owner + '/' + projectData?.repo || 'Repository'}</p>
            <p className="text-sm text-black/50">{projectData?.branch || 'main'}</p>
          </div>
        </div>

        {/* Auto-deploy Toggle */}
        <div className="p-4 rounded-xl bg-black/5 mb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-indigo-600" />
              <span className="text-sm font-medium text-black">Auto-deploy</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={projectData?.auto_deploy || false}
              onClick={handleAutoDeployToggle}
              disabled={loadingAutoDeploy}
              className={`
                relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                ${projectData?.auto_deploy ? 'bg-indigo-600' : 'bg-black/20'}
                ${loadingAutoDeploy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}
              `}
            >
              {loadingAutoDeploy ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mx-auto" />
              ) : (
                <span
                  className={`
                    inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                    ${projectData?.auto_deploy ? 'translate-x-6' : 'translate-x-1'}
                  `}
                />
              )}
            </button>
          </div>
          <p className="text-xs text-black/50">
            {projectData?.auto_deploy
              ? 'Deploys on every push'
              : 'Manual deploys only'}
          </p>
        </div>

        {/* Branch Selection */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-normal text-black">Branch to Deploy</label>
            {!isEditingBranch && (
              <button
                onClick={handleEditBranch}
                disabled={loadingBranch}
                className="p-1.5 text-black/40 hover:text-indigo-600 transition-colors disabled:opacity-50"
              >
                {loadingBranch ? (
                  <div className="w-4 h-4 border-2 border-black/20 border-t-black/60 rounded-full animate-spin" />
                ) : (
                  generateIcon('pen-411-1658238246.png', 16, 'rgb(0, 0, 0, 0.5)')
                )}
              </button>
            )}
          </div>

          {isEditingBranch ? (
            <div className="space-y-3">
              <select
                value={tempBranch}
                onChange={(e) => setTempBranch(e.target.value)}
                className="w-full px-5 py-3 border border-black/10 rounded-[15px] outline-none text-black bg-white focus:ring-2 focus:ring-black focus:border-transparent cursor-text"
              >
                {branches.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
              <p className="text-xs text-black/50 mt-2">
                Choose which branch to deploy from your repository
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleSaveBranch}
                  disabled={loadingBranch}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full transition-all text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <Check className="w-4 h-4" />
                  Save
                </button>
                <button
                  onClick={handleCancelBranch}
                  className="px-4 py-2 bg-black/5 hover:bg-black/10 text-black rounded-full transition-all text-sm font-medium flex items-center gap-2"
                >
                  <X className="w-4 h-4" />
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="relative p-4 bg-white rounded-xl group hover:bg-black/5 transition-all border border-black/10">
              <div className="flex items-center gap-3">
                <GitBranch className="w-5 h-5 text-black/50" />
                <p className="text-sm font-medium text-black flex-1 font-mono">{projectData?.branch || 'main'}</p>
              </div>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="space-y-2">
          <a
            href={projectData?.repositoryUrl || 'https://github.com/' + projectData?.owner + '/' + projectData?.repo}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full px-4 py-2.5 bg-black/5 hover:bg-black/10 text-black rounded-full font-medium text-sm transition-all flex items-center justify-center gap-2"
          >
            {generateIcon('External_link_HtLszLDBXqHilHK674zh2aKoSL7xUhyboAzP.png', 16, 'currentColor')}
            View on GitHub
          </a>
        </div>
      </div>

      {/* Recent Commits - Only show if there are commits */}
      {(projectData?.commitCount || 0) > 0 && (
        <div className="bg-white rounded-[20px] border border-black/5 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-black flex items-center gap-2">
              {generateIcon('commit%20git-24-1658431404.png', 20, 'black')}
              Recent Commits
            </h3>
            <span className="text-xs text-black/50 bg-black/5 px-2 py-1 rounded-full">
              {projectData?.commitCount || 0} total
            </span>
          </div>
          
          {projectData?.recentCommits && projectData.recentCommits.length > 0 ? (
            <div className="space-y-3">
              {projectData.recentCommits.slice(0, 3).map((commit: any, i: number) => (
                <div key={i} className="p-3 bg-black/5 rounded-lg border border-black/10">
                  <div className="flex items-start gap-2 mb-2">
                    <div className="w-2 h-2 bg-indigo-500 rounded-full mt-2 flex-shrink-0"></div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-black truncate">{commit.message}</p>
                      <div className="flex items-center gap-2 text-xs mt-1 text-black/50">
                        <span className="font-mono">{commit.id?.substring(0, 7)}</span>
                        <span>•</span>
                        <span>{formatDate(commit.time, undefined, undefined, true)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-6">
              <GitCommit className="h-8 w-8 text-black/20 mx-auto mb-2" />
              <p className="text-xs text-black/50">No commits yet</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
