import type { Deployment } from "./types";
import type { Dictionary } from "@/i18n";

export const mapRowToDeployment = (row: any): Deployment => {
  const statusMap: Record<string, Deployment["status"]> = {
    ready: "success",
    queued: "pending",
    deploying: "building",
    cancelled: "canceled",
  };
  return {
    id: row.id,
    version: typeof row.version === "number" ? row.version : null,
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
    favicon: row.favicon ?? null,
    failureReason: row.errorMessage ?? undefined,
    /* Rollback state — flows from the listing endpoint, which enriches
     * each row with isActive and surfaces the orchestrator-owned
     * artifactRetainedAt + pinned columns. */
    artifactRetainedAt: row.artifactRetainedAt ?? null,
    pinned: row.pinned ?? false,
    isActive: row.isActive ?? false,
  };
};

/**
 * Formats a date to a human-readable "time ago" string. Labels are threaded
 * in from the active dictionary (`t.deployments.time`) so the caller controls
 * localization — this module stays hook-free.
 */
export const formatDistanceToNow = (
  date: Date,
  labels: Dictionary["deployments"]["time"],
): string => {
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  const fmt = (tmpl: string, n: number) => tmpl.replace("{n}", String(n));

  if (diffInSeconds < 60) return fmt(labels.secondsAgo, diffInSeconds);
  if (diffInSeconds < 3600) return fmt(labels.minutesAgo, Math.floor(diffInSeconds / 60));
  if (diffInSeconds < 86400) return fmt(labels.hoursAgo, Math.floor(diffInSeconds / 3600));
  if (diffInSeconds < 2592000) return fmt(labels.daysAgo, Math.floor(diffInSeconds / 86400));
  if (diffInSeconds < 31536000) return fmt(labels.monthsAgo, Math.floor(diffInSeconds / 2592000));
  return fmt(labels.yearsAgo, Math.floor(diffInSeconds / 31536000));
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
        color: "var(--color-success)",
        bgColor: "bg-success-bg",
        borderColor: "border-success-border",
        label: "Deployed",
      };
    case "failed":
      return {
        icon: 'close remove-802-1662363936.png',
        color: "var(--color-danger)",
        bgColor: "bg-danger-bg",
        borderColor: "border-danger-border",
        label: "Failed",
      };
    case "canceled":
      return {
        icon: 'close%20circle-73-1658234612.png',
        color: "var(--color-neutral)",
        bgColor: "bg-muted/60",
        borderColor: "border-border/50",
        label: "Canceled",
      };
    case "building":
      return {
        icon: 'loading-51-1663582768.png',
        color: "var(--color-info)",
        bgColor: "bg-info-bg",
        borderColor: "border-info-border",
        label: "Building",
      };
    case "deploying":
      return {
        icon: 'loading-51-1663582768.png',
        color: "var(--color-info)",
        bgColor: "bg-info-bg",
        borderColor: "border-info-border",
        label: "Deploying",
      };
    case "cancelled":
      return {
        icon: 'close%20circle-73-1658234612.png',
        color: "var(--color-neutral)",
        bgColor: "bg-muted/60",
        borderColor: "border-border/50",
        label: "Canceled",
      };
    case "partial_failure":
      // Some services succeeded, others failed. Treated as a
      // deployed-with-warnings state — dashboard still shows the
      // deploy as live, but the chip surfaces that the build wasn't
      // wholly green.
      return {
        icon: 'circle%20clock-39-1658435834.png',
        color: "var(--color-warning)",
        bgColor: "bg-warning-bg",
        borderColor: "border-warning-border",
        label: "Partial",
      };
    case "rejected":
      // User rejected a partial/completed deploy: its runtime was torn down and,
      // if it had replaced a previous deployment, that predecessor was restored
      // (otherwise the project falls back to draft). Record + logs are kept.
      return {
        icon: 'close%20circle-73-1658234612.png',
        color: "var(--color-neutral)",
        bgColor: "bg-muted/60",
        borderColor: "border-border/50",
        label: "Rejected",
      };
    case "reconciling":
      // Connection to the server dropped after container(s) started — the
      // outcome is being verified against the live host. Not a failure; the
      // status resolves to deployed/failed once the host is reachable.
      return {
        icon: 'loading-51-1663582768.png',
        color: "var(--color-warning)",
        bgColor: "bg-warning-bg",
        borderColor: "border-warning-border",
        label: "Verifying",
      };
    case "action_required":
      // A failure whose cause we can name and the operator can clear (today: the
      // port was held by another process). Nothing deployed — but unlike a plain
      // red "Failed" there is a next step, so it reads amber to match the project
      // card's "Action Required" badge rather than looking like a dead end.
      return {
        icon: 'circle%20clock-39-1658435834.png',
        color: "var(--color-warning)",
        bgColor: "bg-warning-bg",
        borderColor: "border-warning-border",
        label: "Action required",
      };
    default:
      return {
        icon: 'circle%20clock-39-1658435834.png',
        color: "var(--color-warning)",
        bgColor: "bg-warning-bg",
        borderColor: "border-warning-border",
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
    // Handle both "canceled" and "cancelled" spellings; and count a blocked
    // deploy under "Failed" — it genuinely didn't ship, so hiding it from that
    // tab would make a real failure invisible. The chip still reads "Action
    // required" so the difference isn't lost.
    const deploymentStatus =
      deployment.status === 'cancelled'
        ? 'canceled'
        : deployment.status === 'action_required'
          ? 'failed'
          : deployment.status;
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
    // Blocked deploys count as failed here for the same reason they show under
    // the Failed filter — they didn't ship. Keeping them out would quietly
    // inflate the success rate.
    failed: deployments.filter((d) => d.status === "failed" || d.status === "action_required")
      .length,
    building: deployments.filter((d) => d.status === "building").length,
    pending: deployments.filter((d) => d.status === "pending").length,
    // Handle both "canceled" and "cancelled" spellings
    canceled: deployments.filter((d) => d.status === "canceled" || d.status === "cancelled").length,
  };
};

