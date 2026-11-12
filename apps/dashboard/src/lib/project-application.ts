import { isServicesFramework, resolveWorkload } from "@repo/core";
import type { Service } from "./api/services";

/** One stable navigation identity, independent of whether a service row exists. */
export function projectApplication(
  project: Parameters<typeof hasSeparateApplication>[0],
  services: readonly Service[],
): { mode: "project" | "service"; service?: Service } | null {
  const materialized = services.find((service) => service.applicationMode);
  if (materialized) return { mode: materialized.applicationMode!, service: materialized };
  return hasSeparateApplication(project, services) ? { mode: "project" } : null;
}

export function applicationServiceRoute(service: Pick<Service, "id" | "applicationMode">): string {
  return service.applicationMode ? "application" : service.id;
}

/** The primary app belongs to the project deployment until it is materialized
 * as a service. Lists and topology must not hide it or count it twice. */
export function hasSeparateApplication(
  project: {
    framework: string;
    projectType?: string;
    isApp?: boolean;
    composePath?: string | null;
  },
  services: readonly { kind?: string | null }[],
): boolean {
  if (project.composePath?.trim() || isServicesFramework(project.framework)) return false;
  if (services.some((service) => service.kind === "monorepo")) return false;
  if (project.framework === "unknown" && project.projectType === "services") return false;
  if (project.isApp && services.length > 0) return false;
  return true;
}

/** Whole-project refresh is supported by the service pipeline and by server
 * runtimes. Static build output and single-app Cloud deployments need a rebuild. */
export function canRefreshProjectEnvironment(
  project: Parameters<typeof hasSeparateApplication>[0] & {
    deployTarget?: string | null;
    options?: { workloadType?: string | null; hasServer?: boolean | null };
  },
  services: Parameters<typeof hasSeparateApplication>[1],
): boolean {
  return (
    (!hasSeparateApplication(project, services) &&
      !services.some(
        (service) => "applicationMode" in service && service.applicationMode === "project",
      )) ||
    (project.deployTarget !== "cloud" &&
      resolveWorkload(project.options?.workloadType, project.options?.hasServer) !== "static")
  );
}
