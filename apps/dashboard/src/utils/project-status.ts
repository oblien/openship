export type ProjectStatus =
  | "live"
  | "queued"
  | "building"
  | "deploying"
  | "failed"
  | "cancelled"
  | "draft";

type ProjectStatusSource = {
  activeDeploymentId?: string | null;
  latestDeploymentStatus?: string | null;
};

export const PROJECT_STATUS_META: Record<
  ProjectStatus,
  { label: string; badge: string; dot: string }
> = {
  live: {
    label: "Live",
    badge: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  queued: {
    label: "Queued",
    badge: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    dot: "bg-sky-500",
  },
  building: {
    label: "Building",
    badge: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    dot: "bg-sky-500",
  },
  deploying: {
    label: "Deploying",
    badge: "bg-primary/10 text-primary",
    dot: "bg-primary",
  },
  failed: {
    label: "Failed",
    badge: "bg-red-500/10 text-red-600 dark:text-red-400",
    dot: "bg-red-500",
  },
  cancelled: {
    label: "Cancelled",
    badge: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  draft: {
    label: "Draft",
    badge: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
  },
};

export function getProjectStatus(project: ProjectStatusSource): ProjectStatus {
  switch (project.latestDeploymentStatus) {
    case "queued":
      return "queued";
    case "building":
      return "building";
    case "deploying":
      return "deploying";
    default:
      break;
  }

  if (project.activeDeploymentId) {
    return "live";
  }

  switch (project.latestDeploymentStatus) {
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "draft";
  }
}