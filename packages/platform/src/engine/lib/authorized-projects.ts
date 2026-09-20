import { repos, type Project } from "@repo/db";
import type { ExecutionContext } from "../../context";
import { authorization } from "./authorization";

/** Enumerate a tenant's projects without the old 1,000-row ceiling, filtering before aggregation. */
export async function listAuthorizedProjects(ctx: ExecutionContext | null, organizationId: string): Promise<Project[]> {
  const projects: Project[] = [];
  for (let page = 1; ; page++) {
    const result = await repos.project.listByOrganization(organizationId, { page, perPage: 500 });
    for (const project of result.rows) {
      if (ctx && (ctx.tokenScope || ctx.role === "restricted") &&
        !(await authorization.checkPermissionOnResource({ ...ctx, scopeMode: "fixed" }, { resourceType: "project", resourceId: project.id, action: "read" }))) continue;
      projects.push(project);
    }
    if (result.rows.length < 500 || page * 500 >= result.total) break;
  }
  return projects;
}
