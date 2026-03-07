import React, { useState, useEffect, useRef } from "react";
import { GitBranch, Github, ExternalLink, GitCommit, User, FileCode, Plus, ChevronDown, ChevronRight, Sparkles, Zap, Settings } from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import generateIcon from "@/utils/icons";
import { formatDate } from "@/utils/date";
import FileIcon from "@/components/ui/FileIcon";
import { projectsApi } from "@/lib/api";
// Loading Skeleton Components
const RepositoryInfoSkeleton = () => {
  return (
    <div className="p-5 border border-black/10 rounded-xl bg-white animate-pulse">
      <div className="flex items-start gap-4 mb-5">
        <div className="w-12 h-12 bg-gray-300/30 rounded-xl"></div>
        <div className="flex-1">
          <div className="h-5 w-48 bg-gray-300/30 rounded-full mb-2"></div>
          <div className="flex items-center gap-3">
            <div className="h-6 w-20 bg-gray-200/30 rounded-full"></div>
            <div className="h-4 w-16 bg-gray-200/30 rounded-full"></div>
          </div>
        </div>
      </div>
      <div className="flex gap-3 pt-4 border-t border-black/10">
        <div className="flex-1 h-10 bg-gray-200/30 rounded-full"></div>
        <div className="h-10 w-28 bg-gray-200/30 rounded-full"></div>
      </div>
    </div>
  );
};

const IntegrationStatusSkeleton = () => {
  return (
    <div className="p-5 border border-black/10 rounded-xl bg-white animate-pulse">
      <div className="h-4 w-32 bg-gray-300/30 rounded-full mb-4"></div>
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 bg-gray-100 rounded-lg border border-gray-200">
          <div className="h-3 w-16 bg-gray-200/30 rounded-full mb-1"></div>
          <div className="h-4 w-12 bg-gray-300/30 rounded-full"></div>
        </div>
        <div className="p-3 bg-gray-100 rounded-lg border border-gray-200">
          <div className="h-3 w-16 bg-gray-200/30 rounded-full mb-1"></div>
          <div className="h-4 w-12 bg-gray-300/30 rounded-full"></div>
        </div>
        <div className="col-span-2 p-3 bg-gray-100 rounded-lg border border-gray-200">
          <div className="h-3 w-16 bg-gray-200/30 rounded-full mb-1"></div>
          <div className="h-4 w-20 bg-gray-300/30 rounded-full"></div>
        </div>
      </div>
    </div>
  );
};

const CommitsSkeleton = () => {
  return (
    <div>
      <div className="h-4 w-32 bg-gray-300/30 rounded-full mb-4 animate-pulse"></div>
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white border border-black/10 rounded-lg p-3 animate-pulse">
            <div className="flex items-start gap-2 mb-2">
              <div className="w-4 h-4 bg-gray-200/30 rounded-full mt-0.5"></div>
              <div className="h-5 w-16 bg-gray-200/30 rounded-full"></div>
              <div className="flex-1 min-w-0">
                <div className="h-4 w-full bg-gray-300/30 rounded-full mb-2"></div>
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full bg-gray-200/30"></div>
                  <div className="h-3 w-20 bg-gray-200/30 rounded-full"></div>
                  <div className="h-3 w-16 bg-gray-200/30 rounded-full"></div>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 text-xs ml-6">
              <div className="h-3 w-12 bg-gray-200/30 rounded-full"></div>
              <div className="h-3 w-8 bg-gray-200/30 rounded-full"></div>
              <div className="h-3 w-8 bg-gray-200/30 rounded-full"></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const EmptyCommitsState = () => {
  return (
    <div className="bg-white rounded-[20px] border border-black/5 shadow-sm p-8 text-center">
      <div className="max-w-md mx-auto">
        {generateIcon('git%20branch-159-1658431404.png', 64, 'rgba(79, 70, 229, 0.2)')}
        <h3 className="text-xl font-semibold text-black mb-2 mt-6">
          No Commits Yet
        </h3>
        <p className="text-sm text-black/50 mb-6">
          Push your first commit to see it appear here
        </p>
        
        <div className="bg-indigo-50/50 rounded-xl border border-indigo-100/50 p-5 text-left">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="h-4 w-4 text-indigo-600" />
            <p className="text-sm font-semibold text-black">Quick Start</p>
          </div>
          <div className="space-y-2 text-xs text-black/70">
            <p className="font-mono bg-white px-3 py-2 rounded-lg border border-black/10">
              git add .
            </p>
            <p className="font-mono bg-white px-3 py-2 rounded-lg border border-black/10">
              git commit -m "Initial commit"
            </p>
            <p className="font-mono bg-white px-3 py-2 rounded-lg border border-black/10">
              git push origin main
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

const EmptyStateGit = () => {
  return (
    <div className="bg-white rounded-[20px] border border-black/5 shadow-sm p-10 text-center max-w-2xl mx-auto">
      <Github className="h-16 w-16 text-black/10 mx-auto mb-6" />
      <h3 className="text-2xl font-semibold text-black mb-3">
        Connect Your Repository
      </h3>
      <p className="text-base text-black/50 mb-8 max-w-md mx-auto">
        Link your GitHub repository to enable automatic deployments
      </p>
      
      <div className="flex items-center justify-center gap-3 mb-8">
        <button className="flex items-center gap-2.5 px-6 py-3.5 bg-black text-white hover:bg-gray-900 rounded-full font-medium text-sm transition-all shadow-sm hover:shadow-md">
          <Github className="h-5 w-5" />
          Connect GitHub
        </button>
      </div>

      {/* Features */}
      <div className="grid grid-cols-3 gap-4 pt-6 border-t border-black/10">
        <div className="text-center">
          <Zap className="h-5 w-5 text-indigo-600 mx-auto mb-2" />
          <p className="text-xs text-black/70 font-medium">Auto-Deploy</p>
        </div>
        <div className="text-center">
          <GitBranch className="h-5 w-5 text-indigo-600 mx-auto mb-2" />
          <p className="text-xs text-black/70 font-medium">Branch Previews</p>
        </div>
        <div className="text-center">
          <GitCommit className="h-5 w-5 text-indigo-600 mx-auto mb-2" />
          <p className="text-xs text-black/70 font-medium">Full History</p>
        </div>
      </div>
    </div>
  );
};

export const GitSettings = () => {
  const { gitData, refreshGit, id } = useProjectSettings();
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [isTogglingAutoDeploy, setIsTogglingAutoDeploy] = useState(false);
  const hasRefreshed = useRef(false);

  // Load git data when component mounts - only once
  useEffect(() => {
    if (!hasRefreshed.current) {
      hasRefreshed.current = true;
      refreshGit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAutoDeployToggle = async () => {
    setIsTogglingAutoDeploy(true);
    try {
      const newState = !gitData.autoDeployEnabled;
      // Make API call to toggle auto-deploy
      const response = await projectsApi.setAutoDeploy(id, newState);
      if (response.success) {
        await refreshGit();
      }
    } catch (error) {
      console.error('Failed to toggle auto-deploy:', error);
    } finally {
      setIsTogglingAutoDeploy(false);
    }
  };

  const handleDisconnect = () => {
    
  };

  // Loading State
  if (gitData.isLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Repository Info */}
        <div className="lg:col-span-2 space-y-6">
          <RepositoryInfoSkeleton />
          <IntegrationStatusSkeleton />
        </div>

        {/* Right Column - Recent Commits */}
        <div>
          <CommitsSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div>
      {gitData.repository ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Recent Commits */}
          <div className="lg:col-span-2">
            <h3 className="text-base font-bold text-black mb-4 flex items-center gap-2">
              {generateIcon('commit%20git-24-1658431404.png', 24, 'black')}
              Recent Commits
            </h3>
            {gitData.recentCommits && gitData.recentCommits.length > 0 && false ? (
            <div className="space-y-3">
              {gitData.recentCommits.map((commit, i) => {
                const statusConfig: Record<string, { bg: string; border: string; text: string; label: string }> = {
                  success: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700', label: 'Success' },
                  failed: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', label: 'Failed' },
                  pending: { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-700', label: 'Pending' },
                };
                const config = statusConfig[commit.status] || statusConfig.pending;

                return (
                  <div
                    key={i}
                    className="bg-white border border-black/10 rounded-xl transition-all overflow-hidden"
                  >
                    <div
                      className="p-4 cursor-pointer"
                      onClick={() => setExpandedCommit(expandedCommit === commit.id ? null : commit.id)}
                    >
                      <div className="flex items-start gap-3 mb-3">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <div className="flex-shrink-0 mr-2">
                            {expandedCommit === commit.id ? (
                              generateIcon('chevron%20right-18-1696832403.png', 18, 'rgb(0,0,0,0.5)', { transform: 'rotate(90deg)' })
                            ) : (
                              generateIcon('chevron%20right-18-1696832403.png', 18, 'rgb(0,0,0,0.5)')
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-semibold text-black mb-1 truncate">{commit.message}</p>
                              <code className="bg-black/5 px-2 rounded-full text-black/60 text-xs">
                                {commit.id.substring(0, 7)}
                              </code>
                            </div>
                            <div className="flex items-center gap-2 text-xs mt-1.5 text-black/50 flex-wrap">
                              <div className="flex items-center gap-1.5">
                                {commit.avatar && (<div style={{ backgroundImage: `url(${commit.avatar})` }} className="w-4 h-4 rounded-full bg-cover bg-center bg-no-repeat bg-black/10" />)}
                                <span className="font-normal">{commit.author}</span>
                              </div>
                              <span className="text-black/25">•</span>
                              <span>{formatDate(commit.time, undefined, undefined, true)}</span>
                            </div>
                          </div>
                        </div>
                        <span className={`px-3 py-1 rounded-full text-xs font-semibold ${config.bg} ${config.border} ${config.text} border whitespace-nowrap`}>
                          {config.label}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 text-xs ml-8.5">
                        <div className="flex items-center gap-1.5 text-black/60">
                          {generateIcon('document%20zip-76-1662364367.png', 16, 'rgb(0,0,0,0.4)')}
                          <span className="font-normal">{commit.files} file{commit.files !== 1 ? 's' : ''} changed</span>
                        </div>
                        {commit.url && (
                          <a
                            href={commit.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="flex items-center gap-1 text-black font-normal"
                          >
                            {generateIcon('External_link_HtLszLDBXqHilHK674zh2aKoSL7xUhyboAzP.png', 15, 'rgb(0,0,0,1)')}
                            <span>View on GitHub</span>
                          </a>
                        )}
                      </div>
                    </div>

                    {/* Expandable File Changes */}
                    {expandedCommit === commit.id && commit.changedFiles.length > 0 && (
                      <div className="border-t ml-12 border-black/10 bg-gray-50/50 p-4">
                        <p className="text-xs font-semibold text-black/60 mb-3 uppercase tracking-wide">Changed Files</p>
                        <div className="space-y-1.5">
                          {commit.changedFiles.map((file: any, idx: number) => {
                            const fileTypeConfig: Record<string, { text: string }> = {
                              added: { text: '+ Added' },
                              modified: { text: '~ Modified' },
                              removed: { text: '- Removed' },
                            };
                            const typeConfig = fileTypeConfig[file.type] || fileTypeConfig.modified;

                            return (
                              <div key={idx} className="flex items-center gap-2 p-2.5 bg-white rounded-lg border border-black/5 hover:border-black/10 transition-colors">
                                <div className="flex items-center gap-2 flex-1 min-w-0">
                                  <FileIcon fileName={file.name} language={file.language} style={{}} />
                                  <span className="text-xs text-black/80 truncate font-mono">{file.name}</span>
                                </div>
                                <span className={`text-xs text-black/50 ${typeConfig.text}`}>{typeConfig.text}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            ) : (
              <EmptyCommitsState />
            )}
          </div>

          {/* Right Column - Repository Info (Sticky) */}
          <div className="lg:sticky lg:top-6 h-fit space-y-4">
            {/* Repository Card */}
            <div className="bg-white rounded-[20px] border border-black/5 shadow-sm p-5">
              <div className="flex items-center gap-3 mb-5">
                <Github className="h-6 w-6 text-black" />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-base text-black truncate">{gitData.repository?.name || 'Repository'}</p>
                  <p className="text-xs text-black/50 font-mono">{gitData.branch || 'main'}</p>
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
                    aria-checked={gitData.autoDeployEnabled}
                    onClick={handleAutoDeployToggle}
                    disabled={isTogglingAutoDeploy}
                    className={`
                      relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                      ${gitData.autoDeployEnabled ? 'bg-indigo-600' : 'bg-black/20'}
                      ${isTogglingAutoDeploy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                    `}
                  >
                    <span
                      className={`
                        inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm
                        ${gitData.autoDeployEnabled ? 'translate-x-6' : 'translate-x-1'}
                      `}
                    />
                  </button>
                </div>
                <p className="text-xs text-black/50">
                  {gitData.autoDeployEnabled
                    ? 'Deploys on every push'
                    : 'Manual deploys only'}
                </p>
              </div>

              {/* Action Buttons */}
              <div className="space-y-2">
                <a
                  href={gitData.repository?.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full px-4 py-2.5 bg-black/5 hover:bg-black/10 text-black rounded-full font-medium text-sm transition-all flex items-center justify-center gap-2"
                >
                  {generateIcon('External_link_HtLszLDBXqHilHK674zh2aKoSL7xUhyboAzP.png', 16, 'currentColor')}
                  View on GitHub
                </a>
                <button onClick={handleDisconnect} className="w-full px-4 py-2.5 bg-red-50 text-red-600 hover:bg-red-100 rounded-full font-medium text-sm transition-all">
                  Disconnect
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <EmptyStateGit />
      )}
    </div>
  );
};
