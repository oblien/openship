import type { Deployment } from "./types";

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
        bgColor: "bg-emerald-50",
        borderColor: "border-emerald-200",
        label: "Deployed",
      };
    case "failed":
      return {
        icon: 'close remove-802-1662363936.png',
        color: "var(--color-red-500)",
        bgColor: "bg-red-50",
        borderColor: "border-red-200",
        label: "Failed",
      };
    case "canceled":
      return {
        icon: 'close%20circle-73-1658234612.png',
        color: "var(--color-gray-600)",
        bgColor: "bg-gray-50",
        borderColor: "border-gray-200",
        label: "Canceled",
      };
    case "building":
      return {
        icon: 'loading-51-1663582768.png',
        color: "var(--color-blue-600)",
        bgColor: "bg-blue-50",
        borderColor: "border-blue-200",
        label: "Building",
      };
    default:
      return {
        icon: 'circle%20clock-39-1658435834.png',
        color: "var(--color-gray-600)",
        bgColor: "bg-gray-50",
        borderColor: "border-gray-200",
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

