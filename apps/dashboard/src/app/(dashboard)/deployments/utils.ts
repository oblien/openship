import type { Deployment } from "./types";

export const mapRowToDeployment = (row: any): Deployment => {
  const statusMap: Record<string, Deployment["status"]> = {
    ready: "success",
    queued: "pending",
    deploying: "building",
    cancelled: "canceled",
  };
  return {
    id: row.id,
    status: statusMap[row.status] ?? row.status,
    domain: row.url ?? "",
    framework: row.framework ?? "",
    commit: {
      hash: row.commitSha?.slice(0, 7) ?? "N/A",
      fullHash: row.commitSha ?? null,
      message: row.commitMessage ?? "Manual deployment",
      author: row.meta?.gitOwner ?? "",
      timestamp: row.createdAt,
    },
    buildTime: row.buildDurationMs ? Math.round(row.buildDurationMs / 1000) : null,
    createdAt: row.createdAt,
    type: "git",
    environment: row.environment ?? "production",
    owner: row.meta?.gitOwner,
    repo: row.meta?.gitRepo,
    branch: row.branch ?? undefined,
    projectId: row.projectId,
    projectName: row.projectName,
    failureReason: row.errorMessage ?? undefined,
  };
};

/**
 * Formats a date to a human-readable "time ago" string
 */
export const formatDistanceToNow = (date: Date): string => {
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) return `${diffInSeconds}s ago`;
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
  if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 86400)}d ago`;
  if (diffInSeconds < 31536000) return `${Math.floor(diffInSeconds / 2592000)}mo ago`;
  return `${Math.floor(diffInSeconds / 31536000)}y ago`;
};

/**
 * Formats build time in seconds to a readable string
 */
export const formatBuildTime = (seconds: number | null): string | null => {
  if (!seconds) return null;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
};

/**
 * Gets the status configuration for a deployment
 */
export const getStatusConfig = (status: string) => {
  switch (status) {
    case "success":
      return {
        icon: 'checkmark-72-1658234612.png',
        color: "var(--color-emerald-500)",
        bgColor: "bg-emerald-500/10",
        borderColor: "border-emerald-500/20",
        label: "Deployed",
      };
    case "failed":
      return {
        icon: 'close remove-802-1662363936.png',
        color: "var(--color-red-500)",
        bgColor: "bg-red-500/10",
        borderColor: "border-red-500/20",
        label: "Failed",
      };
    case "canceled":
      return {
        icon: 'close%20circle-73-1658234612.png',
        color: "var(--color-gray-500)",
        bgColor: "bg-muted/60",
        borderColor: "border-border/50",
        label: "Canceled",
      };
    case "building":
      return {
        icon: 'loading-51-1663582768.png',
        color: "var(--color-blue-500)",
        bgColor: "bg-blue-500/10",
        borderColor: "border-blue-500/20",
        label: "Building",
      };
    case "deploying":
      return {
        icon: 'loading-51-1663582768.png',
        color: "var(--color-blue-500)",
        bgColor: "bg-blue-500/10",
        borderColor: "border-blue-500/20",
        label: "Deploying",
      };
    case "cancelled":
      return {
        icon: 'close%20circle-73-1658234612.png',
        color: "var(--color-gray-500)",
        bgColor: "bg-muted/60",
        borderColor: "border-border/50",
        label: "Canceled",
      };
    default:
      return {
        icon: 'circle%20clock-39-1658435834.png',
        color: "var(--color-amber-500)",
        bgColor: "bg-amber-500/10",
        borderColor: "border-amber-500/20",
        label: "Pending",
      };
  }
};

/**
 * Sorts deployments by creation date (most recent first)
 */
export const sortDeploymentsByDate = (deployments: Deployment[]): Deployment[] => {
  return [...deployments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
};

/**
 * Filters deployments based on multiple criteria
 */
export const filterDeployments = (
  deployments: Deployment[],
  filters: {
    status?: "all" | "success" | "failed" | "building" | "pending" | "canceled";
    searchQuery?: string;
    projectId?: string | "all";
  }
): Deployment[] => {
  const { status = "all", searchQuery = "", projectId = "all" } = filters;

  return deployments.filter((deployment) => {
    // Handle both "canceled" and "cancelled" spellings
    const deploymentStatus = deployment.status === 'cancelled' ? 'canceled' : deployment.status;
    const matchesStatus = status === "all" || deploymentStatus === status;
    const matchesSearch =
      !searchQuery ||
      deployment.commit.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
      deployment.commit.hash.toLowerCase().includes(searchQuery.toLowerCase()) ||
      deployment.commit.author.toLowerCase().includes(searchQuery.toLowerCase()) ||
      deployment.projectName?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesProject = projectId === "all" || deployment.projectId === projectId;

    return matchesStatus && matchesSearch && matchesProject;
  });
};

/**
 * Calculates deployment statistics
 */
export const calculateDeploymentStats = (deployments: Deployment[]) => {
  return {
    total: deployments.length,
    success: deployments.filter((d) => d.status === "success").length,
    failed: deployments.filter((d) => d.status === "failed").length,
    building: deployments.filter((d) => d.status === "building").length,
    pending: deployments.filter((d) => d.status === "pending").length,
    // Handle both "canceled" and "cancelled" spellings
    canceled: deployments.filter((d) => d.status === "canceled" || d.status === "cancelled").length,
  };
};

