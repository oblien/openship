import React, { useState } from "react";
import { Search, Star, GitFork, Lock, Globe, Settings } from "lucide-react";
import RepositoryCard from "./RepositoryCard";
import RepositoryMenu from "./RepositoryMenu";
import EmptyState from "./EmptyState";
import { Repository } from "../types";
import colors from "@/utils/colors.json";
import generateIcon from "@/utils/icons";
import FileIcon from "@/components/ui/FileIcon";
import { useRouter } from "next/navigation";

interface RepositoryListProps {
  repositories: Repository[];
  onDeploy: (repo: Repository) => void;
  viewMode?: "list" | "grid";
  onEditWithBlurs: (repo: Repository) => void;
  onMenu: (repo: Repository) => void;
}

const RepositoryList: React.FC<RepositoryListProps> = ({
  repositories,
  onDeploy,
  viewMode = "grid",
  onEditWithBlurs,
  onMenu,
}) => {
  const router = useRouter();
  const [loadingRepoId, setLoadingRepoId] = useState<string | number | null>(null);
  
  const handleCopyUrl = (repository: Repository) => {
    navigator.clipboard.writeText(repository.html_url || '');
    // You can add a toast notification here
  };

  const handleOpenGithub = (repository: Repository) => {
    if (repository.html_url) {
      window.open(repository.html_url, '_blank');
    }
  };

  const handleSettings = (repo: Repository, e: React.MouseEvent) => {
    e.stopPropagation();
    if (repo.deployed) {
      router.push(`/projects/${repo.deployed}`);
    }
  };
  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - date.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 1) return "yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffDays < 30) return `${Math.ceil(diffDays / 7)}w ago`;
    return `${Math.ceil(diffDays / 30)}mo ago`;
  };

  const getLanguageColor = (language: string): string => {
    return colors[language as keyof typeof colors]?.color ?? "#808080";
  };

  if (repositories.length === 0) {
    return (
      <EmptyState
        icon={Search}
        title="No repositories found"
        description="Try adjusting your search terms or filters to find what you're looking for."
      />
    );
  }

  if (viewMode === "list") {
    return (
      <div className="space-y-4">
        {repositories.map((repo, i) => (
          <div
            key={repo.id || i}
            className={`relative overflow-hidden bg-white rounded-[20px] transition-all duration-300 group cursor-pointer ${loadingRepoId === (repo.id || i) ? 'opacity-90' : ''}`}
            onClick={() => {
              if (loadingRepoId === (repo.id || i)) return;
              setLoadingRepoId(repo.id || i);
              onDeploy(repo);
            }}
          >
            {/* Hover-activated overlay that sticks when clicked */}
            <span className={`absolute inset-0 -translate-x-full group-hover:translate-x-0 ${loadingRepoId === (repo.id || i) ? 'translate-x-0' : ''} transition-transform duration-200 ease-out bg-black/5 rounded-[20px]`}></span>
            <div className="flex flex-col lg:flex-row items-start lg:items-center gap-4 lg:gap-6 p-4 sm:p-5">
              {/* Icon + Name/Status */}
              <div className="flex items-center gap-3 lg:gap-4 flex-1 min-w-0 w-full lg:w-auto">
                {/* GitHub Icon */}
                <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-black/5 flex items-center justify-center flex-shrink-0 group-hover:bg-gray-100 transition-colors">
                  {generateIcon('code-19-1661162415.png', 24, 'rgb(0, 0, 0, 0.50)')}
                </div>

                {/* Name + Description + Stats */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 sm:gap-3 mb-1 flex-wrap">
                    <h3 className="text-sm sm:text-base font-semibold text-black truncate">
                      {repo.full_name}
                    </h3>
                    {repo.private ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-normal bg-indigo-500/10 text-indigo-500/70 text-xs flex-shrink-0">
                        Private
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-normal bg-indigo-500/10 text-indigo-500/70 text-xs flex-shrink-0">
                        Public
                      </span>
                    )}
                  </div>

                  <p className="text-xs sm:text-sm text-black/50 mb-2 line-clamp-1">
                    {repo.description || "No description provided"}
                  </p>

                  {/* Stats */}
                  <div className="flex items-center gap-2 sm:gap-3 text-xs text-black/50 flex-wrap">
                    <div className="flex items-center gap-0">
                      <FileIcon language={repo.language?.toLowerCase() || "unknown"} style={{ fontSize: '16px', opacity: 0.6, marginRight: '6px', color: 'var(--color-indigo-500)' }} />
                      <span className="font-normal">{repo.language || "Unknown"}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      {generateIcon('star-66-1658435608.png', 16, 'rgb(0, 0, 0, 0.50)')}
                      <span className="font-normal text-xs">{repo.stars}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      {generateIcon('git%20branch-159-1658431404.png', 16, 'rgb(0, 0, 0, 0.50)')}
                      <span className="font-normal text-xs">{repo.forks}</span>
                    </div>
                    <span className="text-black/25 hidden sm:inline">•</span>
                    <span className="font-normal hidden sm:inline">{formatDate(repo.updated_at)}</span>
                  </div>
                </div>
              </div>
              
              {/* Actions - Stack on mobile */}
              <div className="flex items-center gap-2 w-full lg:w-auto lg:flex-shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditWithBlurs(repo);
                  }}
                  className="hidden sm:inline-flex text-sm rounded-full items-center gap-2 px-6 py-2.5 bg-white text-black font-normal border border-black/10"
                >
                  Edit with Blurs
                </button>
       
                {repo.deployed ? (
                  <button
                    onClick={(e) => handleSettings(repo, e)}
                    className="flex-1 sm:flex-initial w-10 h-10 rounded-full bg-black flex items-center justify-center border border-black/10 transition-colors"
                  >
                    {generateIcon('setting-100-1658432731.png', 22, 'white')}
                  </button>
                ): (
                  <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (loadingRepoId === (repo.id || i)) return;
                    setLoadingRepoId(repo.id || i);
                    onDeploy(repo);
                  }}
                  className={`flex-1 sm:flex-initial inline-flex justify-center rounded-full items-center gap-2 px-6 py-2.5 ${loadingRepoId === (repo.id || i) ? 'bg-gray-800' : 'bg-black hover:bg-gray-900'} text-white text-sm font-normal transition-colors ${loadingRepoId === (repo.id || i) ? '' : 'hover:shadow-md'}`}
                  disabled={loadingRepoId === (repo.id || i)}
                >
                  {loadingRepoId === (repo.id || i) ? 'Deploying…' : 'Deploy'}
                </button>
                )}
                <div onClick={(e) => e.stopPropagation()}>
                  <RepositoryMenu
                    repository={repo}
                    onDeploy={onDeploy}
                    onSettings={onEditWithBlurs}
                    onCopyUrl={handleCopyUrl}
                    onOpenGithub={handleOpenGithub}
                    triggerClassName="w-10 h-10 rounded-full bg-white flex items-center justify-center border border-black/10 hover:bg-gray-50 transition-colors flex-shrink-0"
                  />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Grid view
  return (
    <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
      {repositories.map((repo, i) => (
        <RepositoryCard 
          key={repo.id || i} 
          repo={repo} 
          onDeploy={onDeploy}
          onEditWithBlurs={onEditWithBlurs}
          onMenu={onMenu}
        />
      ))}
    </div>
  );
};

export default RepositoryList;
