"use client";

import { isServicesFramework } from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { getFrameworkConfig } from "@/components/import-project/Frameworks";

/** Fallback identity after a catalog logo or favicon, shared by project rows
 * and deployment history. A missing framework never implies a static site. */
export function ProjectStackIcon({
  framework,
  serviceDeploymentMode,
  className = "size-6",
}: {
  framework?: string | null;
  serviceDeploymentMode?: "services" | "single";
  className?: string;
}) {
  const config = getFrameworkConfig(framework ?? "");
  if (
    isServicesFramework(framework) ||
    (config.id === "unknown" && serviceDeploymentMode === "services")
  ) {
    return <Icon name="layers" className={className} />;
  }
  if (config.id === "unknown") return <Icon name="window" className={className} />;
  return (
    <span className={`inline-flex shrink-0 ${className}`}>{config.icon("var(--foreground)")}</span>
  );
}
