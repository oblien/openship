import React from "react";
import { Star, GitFork, Lock, Globe, Settings } from "lucide-react";
import { Repository } from "../types";
import { generateIcon } from "@/utils/icons";
import colors from "@/utils/colors.json";
import FileIcon from "@/components/ui/FileIcon";
import RepositoryMenu from "./RepositoryMenu";
import { useRouter } from "next/navigation";

interface RepositoryCardProps {
  repo: Repository;
  onDeploy: (repo: Repository) => void;
  onEditWithBlurs?: (repo: Repository) => void;
  onMenu?: (repo: Repository) => void;
}

const RepositoryCard: React.FC<RepositoryCardProps> = ({ repo, onDeploy, onEditWithBlurs, onMenu }) => {
  const router = useRouter();

  const handleCopyUrl = (repository: Repository) => {
    navigator.clipboard.writeText(repository.html_url || '');
    // You can add a toast notification here
  };

  const handleOpenGithub = (repository: Repository) => {
    if (repository.html_url) {
      window.open(repository.html_url, '_blank');
    }
  };

  const handleSettings = (e: React.MouseEvent) => {
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

  return (
    <div
      className="bg-white rounded-[20px] transition-all duration-300 group cursor-pointer hover:"
      onClick={() => onDeploy(repo)}
    >
      <div className="p-5 flex flex-col h-full">
        {/* Header with Icon */}
        <div className="flex items-start gap-3 mb-4">
          {/* <div className="w-12 h-12 rounded-xl bg-black/5 flex items-center justify-center flex-shrink-0 group-hover:bg-gray-100 transition-colors">
            {generateIcon('code-19-1661162415.png', 26, 'rgb(0, 0, 0, 0.50)')}
          </div> */}
          <div className="flex justify-between w-full gap-4">
            <h3 className="text-base font-semibold text-black truncate mb-1">
              {repo.full_name}
            </h3>

            {repo.private ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-normal bg-indigo-500/10 text-indigo-500/70 text-xs">
                Private
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-normal bg-indigo-500/10 text-indigo-500/70 text-xs">
                Public
              </span>
            )}
          </div>
        </div>

        {/* Description */}
        <p className="text-sm text-black/50 mb-4 line-clamp-2 flex-1" style={{ minHeight: '20px' }}>
          {repo.description || "No description provided"}
        </p>

        {/* Stats */}
        <div className="flex items-center gap-3 text-xs text-black/50 mb-4 pb-3 border-b border-gray-100">
          <div className="flex items-center gap-0">
            <FileIcon language={repo.language?.toLowerCase() || "unknown"} style={{ fontSize: '18px', marginRight: '10px', color: 'var(--color-indigo-500)' }} />
            <span className="font-normal">{repo.language || "Unknown"}</span>
          </div>
          <div className="flex items-center gap-1">
            {generateIcon('star-66-1658435608.png', 18, 'rgb(0, 0, 0, 0.50)')}
            <span className="font-normal text-xs">{repo.stars}</span>
          </div>
          <div className="flex items-center gap-1">
            {generateIcon('git%20branch-159-1658431404.png', 18, 'rgb(0, 0, 0, 0.50)')}
            <span className="font-normal text-xs">{repo.forks}</span>
          </div>
          <span className="text-black/25">•</span>
          <span className="font-normal">{formatDate(repo.updated_at)}</span>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEditWithBlurs?.(repo);
            }}
            className="flex-1 text-sm rounded-full px-4 py-2.5 bg-white text-black font-normal border border-black/10 hover:bg-black/5 transition-colors"
          >
            Clone in Blurs
          </button>
          {repo.deployed ? (
            <>
            <div onClick={(e) => e.stopPropagation()}>
            <RepositoryMenu
              repository={repo}
              onDeploy={onDeploy}
              onSettings={onEditWithBlurs}
              onCopyUrl={handleCopyUrl}
              onOpenGithub={handleOpenGithub}
              triggerClassName="w-10 h-10 rounded-full bg-white flex items-center justify-center border border-black/10 hover:bg-gray-50 transition-colors"
            />
          </div>
              <button
                onClick={handleSettings}
                className="w-10 h-10 rounded-full bg-black flex items-center justify-center border border-black/10 ml-1 transition-colors"
              >
                {generateIcon('setting-100-1658432731.png', 24, 'white')}
              </button>
             
            </>
          ) : (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeploy(repo);
              }}
              className="flex-1 rounded-full px-4 py-2.5 bg-black text-white text-sm font-normal hover:bg-gray-900 transition-all hover:"
            >
              Deploy
            </button>)}
        </div>
      </div>
    </div>
  );
};

export default RepositoryCard;
