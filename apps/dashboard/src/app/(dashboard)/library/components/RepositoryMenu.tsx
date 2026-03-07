import React from "react";
import {
  Rocket,
  Settings,
  Eye,
  Copy,
  ExternalLink,
  Archive,
  Trash2,
  GitBranch,
  Star,
} from "lucide-react";
import DropdownMenu, { MenuAction } from "@/components/ui/DropdownMenu";
import { Repository } from "../types";

interface RepositoryMenuProps {
  repository: Repository;
  onDeploy?: (repo: Repository) => void;
  onSettings?: (repo: Repository) => void;
  onViewDeployments?: (repo: Repository) => void;
  onCopyUrl?: (repo: Repository) => void;
  onOpenGithub?: (repo: Repository) => void;
  onArchive?: (repo: Repository) => void;
  onDelete?: (repo: Repository) => void;
  onViewBranches?: (repo: Repository) => void;
  onStar?: (repo: Repository) => void;
  className?: string;
  triggerClassName?: string;
}

const RepositoryMenu: React.FC<RepositoryMenuProps> = ({
  repository,
  onDeploy,
  onSettings,
  onViewDeployments,
  onCopyUrl,
  onOpenGithub,
  onArchive,
  onDelete,
  onViewBranches,
  onStar,
  className,
  triggerClassName,
}) => {
  const actions: MenuAction[] = [
    // Primary actions
    ...(onDeploy
      ? [
          {
            id: "deploy",
            label: "Deploy Now",
            icon: <Rocket className="w-4 h-4" />,
            onClick: () => onDeploy(repository),
          },
        ]
      : []),
    
    ...(onSettings
      ? [
          {
            id: "settings",
            label: "Project Settings",
            icon: <Settings className="w-4 h-4" />,
            onClick: () => onSettings(repository),
          },
        ]
      : []),

    ...(onViewDeployments
      ? [
          {
            id: "deployments",
            label: "View Deployments",
            icon: <Eye className="w-4 h-4" />,
            onClick: () => onViewDeployments(repository),
          },
        ]
      : []),

    // Repository actions
    ...(onViewBranches
      ? [
          {
            id: "branches",
            label: "View Branches",
            icon: <GitBranch className="w-4 h-4" />,
            onClick: () => onViewBranches(repository),
            divider: true,
          },
        ]
      : []),

    ...(onCopyUrl
      ? [
          {
            id: "copy",
            label: "Copy Repository URL",
            icon: <Copy className="w-4 h-4" />,
            onClick: () => onCopyUrl(repository),
          },
        ]
      : []),

    ...(onOpenGithub
      ? [
          {
            id: "github",
            label: "Open in GitHub",
            icon: <ExternalLink className="w-4 h-4" />,
            onClick: () => onOpenGithub(repository),
          },
        ]
      : []),

    ...(onStar
      ? [
          {
            id: "star",
            label: "Star Repository",
            icon: <Star className="w-4 h-4" />,
            onClick: () => onStar(repository),
          },
        ]
      : []),

    // Destructive actions
    ...(onArchive
      ? [
          {
            id: "archive",
            label: "Archive Project",
            icon: <Archive className="w-4 h-4" />,
            onClick: () => onArchive(repository),
            variant: "warning" as const,
            divider: true,
          },
        ]
      : []),

    ...(onDelete
      ? [
          {
            id: "delete",
            label: "Delete Project",
            icon: <Trash2 className="w-4 h-4" />,
            onClick: () => onDelete(repository),
            variant: "danger" as const,
          },
        ]
      : []),
  ];

  return <DropdownMenu actions={actions} className={className} triggerClassName={triggerClassName} />;
};

export default RepositoryMenu;
