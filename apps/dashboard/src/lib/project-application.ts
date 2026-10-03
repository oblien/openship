import { isServicesFramework } from "@repo/core";

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
