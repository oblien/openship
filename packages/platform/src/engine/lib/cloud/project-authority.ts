import { repos } from "@repo/db";
import { env } from "../../config/index";
import { resolveOrgCloudUserId } from "./transport";

export type ProjectSource = "local" | "cloud";

/** Resource authority without HTTP state, also used by native deployment operations. */
export async function resolveProjectAuthority(
  projectId: string,
  organizationId: string,
  hint?: ProjectSource,
): Promise<ProjectSource | "not-found"> {
  // On the SaaS we ARE the canonical store — never proxy.
  if (env.CLOUD_MODE) return "local";

  if (hint === "cloud") return "cloud";
  if (hint === "local") return "local";

  const local = await repos.project.findById(projectId).catch(() => null);
  if (local) return "local";

  // No local row — it's a cloud project iff the org has a cloud link to proxy
  // through. No link → genuinely not found (IDOR-safe: same 404 as a foreign id).
  const ownerUserId = await resolveOrgCloudUserId(organizationId).catch(() => null);
  return ownerUserId ? "cloud" : "not-found";
}
