import React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, GitBranch, Globe, Server, FolderOpen } from "lucide-react";
import { type Project } from "@/constants/mock";
import { getFrameworkConfig } from "@/components/import-project/Frameworks";
import { getProjectStatus, PROJECT_STATUS_META } from "@/utils/project-status";
import { getProjectType } from "@repo/core";
import { usePlatform } from "@/context/PlatformContext";

/* ── Helpers ──────────────────────────────────────────────────────── */

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/* ── Component ────────────────────────────────────────────────────── */

interface Props {
  project: Project;
}

const ProjectCard: React.FC<Props> = ({ project }) => {
  const router = useRouter();
  const { baseDomain } = usePlatform();
  const status = getProjectStatus(project);
  const statusMeta = PROJECT_STATUS_META[status];
  const fw = getFrameworkConfig(project.framework);

  const isLocal = !!project.localPath;
  const hasRepo = !!(project.gitOwner && project.gitRepo);
  const repoSlug = hasRepo ? `${project.gitOwner}/${project.gitRepo}` : null;
  const domain = project.slug ? `${project.slug}.${baseDomain}` : null;
  const isServicesProject = (() => {
    try {
      return getProjectType(project.framework as any) === "services";
    } catch {
      return false;
    }
  })();

  const clickTarget = `/projects/${project.id}`;

  return (
    <div
      onClick={() => router.push(clickTarget)}
      className="flex items-center gap-4 px-5 py-3.5 hover:bg-muted/40 transition-colors cursor-pointer group"
    >
      {/* Framework icon */}
      <div className="w-10 h-10 rounded-xl bg-muted/60 flex items-center justify-center shrink-0 group-hover:bg-muted transition-colors">
        {fw.icon("hsl(var(--foreground))")}
      </div>

      {/* Name + slug */}
      <div className="min-w-0 flex-shrink-0 w-44 lg:w-56">
        <p className="text-sm font-medium text-foreground truncate">{project.name}</p>
        {domain && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{domain}</p>
        )}
      </div>

      {/* Meta badges */}
      <div className="flex-1 min-w-0 flex items-center gap-3 overflow-hidden">
        {/* Stack */}
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-muted/60 text-xs text-muted-foreground shrink-0">
          {fw.name}
        </span>

        {/* Source */}
        {isLocal ? (
          <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <FolderOpen className="size-3.5" />
            <span className="truncate max-w-[140px]">Local</span>
          </span>
        ) : repoSlug ? (
          <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <GitBranch className="size-3.5" />
            <span className="truncate max-w-[140px]">{project.gitRepo}</span>
          </span>
        ) : null}

        {/* Build target */}
        {isServicesProject ? (
          <span className="hidden md:inline-flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <Server className="size-3.5" />
            Services
          </span>
        ) : project.hasServer === false ? (
          <span className="hidden md:inline-flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <Globe className="size-3.5" />
            Static
          </span>
        ) : project.productionMode === "standalone" ? (
          <span className="hidden md:inline-flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <Server className="size-3.5" />
            Standalone
          </span>
        ) : null}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-3 shrink-0">
        {/* Time */}
        <span className="hidden lg:block text-xs text-muted-foreground">
          {timeAgo(project.updatedAt || project.createdAt)}
        </span>

        {/* Status pill */}
        <span
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium ${statusMeta.badge}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dot}`} />
          {statusMeta.label}
        </span>

        <ArrowRight className="size-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
      </div>
    </div>
  );
};

export default ProjectCard;