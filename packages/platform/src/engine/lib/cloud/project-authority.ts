import { resolveResourceAuthority } from "./resource-authority";

export type ProjectSource = "local" | "cloud";

/** Resource authority without HTTP state, also used by native deployment operations. */
export async function resolveProjectAuthority(
  projectId: string,
  organizationId: string,
  hint?: ProjectSource,
): Promise<ProjectSource | "not-found"> {
  // A client hint cannot move a local record to another control plane.
  if (hint === "local") return "local";
  return resolveResourceAuthority("project", projectId, organizationId);
}
