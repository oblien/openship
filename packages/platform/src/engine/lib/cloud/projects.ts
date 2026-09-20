import { env } from "../../config/index";
import { cloudClient } from "./client";
import { resolveOrgCloudUserId, readCloudJson } from "./transport";

/**
 * Fetch an org's CLOUD projects from the SaaS, proxied as the org owner's
 * cloud identity. Shared by the home-list merge (project.controller) and the
 * grant picker (permissions.controller) so both see the same set.
 *
 *   - not-connected: on the SaaS itself (we ARE the source), or the org has no
 *                    cloud link → callers show local only.
 *   - unavailable:   linked but the SaaS call failed / returned non-JSON →
 *                    callers show local only (+ a partial warning where useful).
 *   - merged:        the SaaS projects + headline numbers.
 */
export type CloudProjectsResult =
  | { state: "merged"; projects: Array<Record<string, unknown>>; numbers: Record<string, number> }
  | { state: "not-connected" }
  | { state: "unavailable" };

export async function fetchOrgCloudProjects(
  organizationId: string,
): Promise<CloudProjectsResult> {
  // On the SaaS we ARE the source — never merge-from-self (no proxy recursion).
  if (env.CLOUD_MODE) return { state: "not-connected" };
  const linked = await resolveOrgCloudUserId(organizationId).catch(() => null);
  if (!linked) return { state: "not-connected" };
  const res = await cloudClient({ organizationId })
    .request("/api/projects/home", { method: "GET" })
    .catch(() => null);
  if (!res || !res.ok) return { state: "unavailable" };
  const body = await readCloudJson<{ projects?: unknown[]; numbers?: Record<string, number> }>(res);
  if (!body || !Array.isArray(body.projects)) return { state: "unavailable" };
  return {
    state: "merged",
    projects: body.projects as Array<Record<string, unknown>>,
    numbers: body.numbers ?? {},
  };
}
