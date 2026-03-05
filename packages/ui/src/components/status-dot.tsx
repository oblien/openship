import { cn } from "../lib/cn";
import type { DeploymentStatus } from "openship-core";

const statusColors: Record<string, string> = {
  queued: "bg-gray-400",
  building: "bg-yellow-400 animate-pulse",
  deploying: "bg-blue-400 animate-pulse",
  ready: "bg-green-500",
  failed: "bg-red-500",
  cancelled: "bg-gray-400",
};

interface StatusDotProps {
  status: DeploymentStatus;
  className?: string;
}

export function StatusDot({ status, className }: StatusDotProps) {
  return (
    <span
      className={cn("inline-block h-2.5 w-2.5 rounded-full", statusColors[status], className)}
      title={status}
    />
  );
}
