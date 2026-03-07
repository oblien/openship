import { formatDate } from "@/utils/date";
import React from "react";
import { generateIcon } from "@/utils/icons";
import { frameworks } from "@/components/import-project/Frameworks";
import { useRouter } from "next/navigation";
import DropdownMenu, { MenuAction } from "@/components/ui/DropdownMenu";
import { Star } from "lucide-react";

interface Props {
  project: {
    id: string;
    name: string;
    domain: string;
    description?: string;
    framework: string;
    status: string;
    lastDeployed: string;
    repo?: string;
    url?: string;
  };
  viewMode?: "grid" | "list";
  isPinned?: boolean;
  onTogglePin?: () => void;
}

const ProjectCard = ({ project, viewMode = "list", isPinned = false, onTogglePin }: Props) => {
  const isGridView = viewMode === "grid";
  const router = useRouter();

  // Get framework icon or fallback
  const getFrameworkIcon = () => {
    const framework = frameworks.find(f => f.id === project.framework.toLowerCase());
    if (framework) {
      return framework.icon('var(--th-text-body)');
    }
    // Default fallback icon
    return generateIcon('folder%20file%20zip-92-1661323044.png', 40, 'var(--th-text-body)');
  };

  // Menu actions for the dropdown
  const menuActions: MenuAction[] = [
    { 
      id: "general", 
      label: "General", 
      icon: 'setting-100-1658432731.png',
      onClick: () => router.push(`/projects/${project.id}/general`)
    },
    { 
      id: "domains", 
      label: "Domains", 
      icon: 'server-59-1658435258.png',
      onClick: () => router.push(`/projects/${project.id}/domains`)
    },
    { 
      id: "deployments", 
      label: "Deployments", 
      icon: 'heart%20rate-118-1658433496.png',
      onClick: () => router.push(`/projects/${project.id}/deployments`)
    },
    { 
      id: "build", 
      label: "Build", 
      icon: 'tools-118-1658432731.png',
      onClick: () => router.push(`/projects/${project.id}/build`),
      divider: true
    },
    { 
      id: "logs", 
      label: "Logs", 
      icon: 'terminal-184-1658431404.png',
      onClick: () => router.push(`/projects/${project.id}/logs`)
    },
    { 
      id: "advanced", 
      label: "Advanced", 
      icon: 'error%20triangle-81-1658234612.png',
      onClick: () => router.push(`/projects/${project.id}/advanced`),
      variant: "warning" as const
    },
  ];

  const getStatusConfig = (status: string) => {
    switch (status) {
      case "live":
        return {
          bg: "bg-emerald-500/10",
          text: "text-emerald-700",
          dot: "bg-emerald-500",
          ring: "ring-1 ring-emerald-500/20"
        };
      case "failed":
        return {
          bg: "bg-red-500/10",
          text: "text-red-700",
          dot: "bg-red-600",
          ring: "ring-1 ring-red-500/20"
        };
      case "building":
        return {
          bg: "bg-indigo-500/10",
          text: "text-indigo-700",
          dot: "bg-indigo-600",
          ring: "ring-1 ring-indigo-500/20"
        };
      default:
        return {
          bg: "bg-muted",
          text: "text-muted-foreground",
          dot: "bg-muted-foreground",
          ring: ""
        };
    }
  };

  const statusConfig = getStatusConfig(project.status);

  if (viewMode === "list") {
    return (
      <div className="bg-card rounded-xl border border-border/50 hover:border-border transition-all group">
        <div className="flex flex-col lg:flex-row items-start lg:items-center gap-4 lg:gap-6 p-4 lg:p-5" onClick={() => router.push(`/projects/${project.id}`)} style={{ cursor: 'pointer' }}>
          {/* Icon + Name/Domain + Status */}
          <div className="flex items-center gap-3 lg:gap-4 w-full lg:w-auto lg:min-w-0 lg:flex-[0_0_320px]">
            <div className="w-11 h-11 lg:w-12 lg:h-12 rounded-xl bg-muted flex items-center justify-center flex-shrink-0 group-hover:bg-muted/80 transition-all">
              {getFrameworkIcon()}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-medium text-foreground truncate mb-0.5">
                {project.name}
              </h3>
              <p className="text-xs text-muted-foreground truncate">{project.domain}</p>
            </div>

            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium flex-shrink-0 ${statusConfig.bg} ${statusConfig.text} ${statusConfig.ring}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${statusConfig.dot}`}></span>
              {project.status === 'live' ? 'Live' : project.status === 'building' ? 'Building' : project.status}
            </span>
          </div>

          {/* Description/Date */}
          <div className="flex-1 min-w-0 w-full lg:w-auto lg:pl-4">
            <p className="text-sm font-medium text-foreground/80 truncate mb-1.5">
              {project.description}
            </p>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                {generateIcon('circle%20clock-39-1658435834.png', 14, 'var(--th-text-muted)')}
                <span>{formatDate(project.lastDeployed)}</span>
              </div>
              <span className="text-muted-foreground/40">•</span>
              <div className="flex items-center gap-1.5">
                {generateIcon('git%20branch-159-1658431404.png', 14, 'var(--th-text-muted)')}
                <span>main</span>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 flex-shrink-0 w-full lg:w-auto">
            {/* Repo Link */}
            {project.repo && (
              <a
                href={`https://github.com/${project.repo}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="hidden lg:inline-flex items-center gap-2 px-3 py-2 bg-muted/50 hover:bg-muted border border-border/50 rounded-lg text-xs text-muted-foreground hover:text-foreground transition-all flex-shrink-0"
              >
                {generateIcon('github-8-1693375538.png', 16, 'currentColor')}
                <span className="max-w-[120px] truncate font-medium">{project.repo.split('/').pop()}</span>
              </a>
            )}
            
            {project.status === "live" && (
              <a
                href={project.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="flex-1 lg:flex-initial inline-flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-all"
              >
                {generateIcon('External_link_HtLszLDBXqHilHK674zh2aKoSL7xUhyboAzP.png', 14, 'var(--th-btn-text)')}
                Visit
              </a>
            )}

            {onTogglePin && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin();
                }}
                className={`w-9 h-9 flex items-center justify-center border rounded-lg transition-all flex-shrink-0 ${
                  isPinned
                    ? 'border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-amber-600'
                    : 'border-border/50 hover:bg-muted text-muted-foreground hover:text-amber-500'
                }`}
                title={isPinned ? 'Unpin project' : 'Pin project'}
              >
                {generateIcon(isPinned ? 'pin-91-1662481030.png' : 'pin-210-1658433759.png', 18, 'currentColor')}
              </button>
            )}

            <div onClick={(e) => e.stopPropagation()}>
              <DropdownMenu
                actions={menuActions}
                align="right"
                triggerClassName="w-9 h-9 flex items-center justify-center border border-border/50 hover:bg-muted text-muted-foreground hover:text-foreground rounded-lg transition-all flex-shrink-0"
                trigger={generateIcon('info%20menu-42-1661490994.png', 18, 'currentColor')}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Grid View
  return (
    <div 
      className="bg-card rounded-xl transition-all duration-300 group cursor-pointer border border-border/50 hover:border-border" 
      onClick={() => router.push(`/projects/${project.id}`)}
    >
      <div className="p-4 flex flex-col h-full">
        {/* Header with Icon and Status */}
        <div className="flex items-start gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center flex-shrink-0 group-hover:bg-muted/80 transition-colors">
            {getFrameworkIcon()}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium text-foreground truncate mb-0.5">
              {project.name}
            </h3>
            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-normal ${statusConfig.bg} ${statusConfig.text} ${statusConfig.ring}`}>
              <span className={`w-1 h-1 rounded-full ${statusConfig.dot}`}></span>
              {project.status === 'live' ? 'Live' : project.status === 'building' ? 'Building' : project.status}
            </span>
          </div>
          {onTogglePin && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin();
              }}
              className={`w-8 h-8 flex items-center justify-center border rounded-lg transition-all flex-shrink-0 ${
                isPinned
                  ? 'border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-amber-600'
                  : 'border-border/50 hover:bg-muted text-muted-foreground hover:text-amber-500'
              }`}
              title={isPinned ? 'Unpin project' : 'Pin project'}
            >
              <Star className={`w-3.5 h-3.5 ${isPinned ? 'fill-amber-500' : ''}`} />
            </button>
          )}
        </div>

        {/* Domain */}
        <p className="text-xs text-muted-foreground mb-2 truncate">
          {project.domain}
        </p>

        {/* Description */}
        <p className="text-xs text-muted-foreground mb-3 line-clamp-2 flex-1" style={{ minHeight: '32px' }}>
          {project.description || "No description"}
        </p>

        {/* Meta Info */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3 pb-3 border-b border-border/50">
          <div className="flex items-center gap-1">
            {generateIcon('circle%20clock-39-1658435834.png', 14, 'var(--th-text-muted)')}
            <span className="font-normal">{formatDate(project.lastDeployed)}</span>
          </div>
          <span className="text-muted-foreground/40">•</span>
          <div className="flex items-center gap-1">
            {generateIcon('git%20branch-159-1658431404.png', 14, 'var(--th-text-muted)')}
            <span className="font-normal">main</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          {project.status === "live" ? (
            <a
              href={project.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex-1 rounded-lg px-3 py-2 bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-all inline-flex items-center justify-center gap-2"
            >
              {generateIcon('External_link_HtLszLDBXqHilHK674zh2aKoSL7xUhyboAzP.png', 14, 'var(--th-btn-text)')}
              Visit
            </a>
          ) : (
            <button
              onClick={(e) => e.stopPropagation()}
              className="flex-1 rounded-lg px-3 py-2 bg-muted text-foreground text-sm font-medium border border-border/50 hover:bg-muted/80 transition-all"
            >
              View Logs
            </button>
          )}
          
          <div onClick={(e) => e.stopPropagation()}>
            <DropdownMenu
              actions={menuActions}
              align="right"
              triggerClassName="w-9 h-9 rounded-lg bg-card flex items-center justify-center border border-border/50 hover:bg-muted transition-all"
              trigger={generateIcon('info%20menu-42-1661490994.png', 16, 'var(--th-text-muted)')}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProjectCard;