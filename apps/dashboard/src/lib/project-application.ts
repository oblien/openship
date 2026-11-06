import { isServicesFramework, resolveWorkload } from "@repo/core";

/** The primary app belongs to the project deployment until it is materialized
 * as a service. Lists and topology must not hide it or count it twice. */
export function hasSeparateApplication(
  project: { framework: string; projectType?: string; isApp?: boolean },
  services: readonly { kind?: string | null }[],
): boolean {
  if (isServicesFramework(project.framework)) return false;
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
    !hasSeparateApplication(project, services) ||
    (project.deployTarget !== "cloud" &&
      resolveWorkload(project.options?.workloadType, project.options?.hasServer) !== "static")
  );
}
