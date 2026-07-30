import { describe, expect, it } from "vitest";
import {
  filterToolsForPrincipal,
  type McpToolDef,
  type McpPrincipal,
} from "../../../src/modules/mcp/mcp-tools";

/**
 * Regression for the repo-scoped `tools/list` gap: a token granted a single
 * GitHub repo (grant type `github_repository`) must still SEE the per-repo
 * GitHub tools, and per-resource list tools (with path params) must not be
 * treated as org-wide wildcards. See mcp-tools.filterToolsForPrincipal.
 */

type PartialPerm = Omit<McpToolDef["perm"], "projectCreate"> & { projectCreate?: boolean };

function tool(partial: Partial<McpToolDef> & { method: string; perm: PartialPerm }): McpToolDef {
  return {
    name: partial.name ?? "t",
    description: "",
    inputSchema: {},
    annotations: { readOnlyHint: partial.method === "GET", destructiveHint: false },
    method: partial.method,
    path: partial.path ?? "/api/x",
    pathParams: partial.pathParams ?? [],
    hasBody: partial.hasBody ?? false,
    perm: { projectCreate: false, ...partial.perm },
  };
}

// A representative slice of the real tool set.
const ghGetRepo = tool({
  name: "get_github_repos_by_owner_by_repo",
  method: "GET",
  perm: { root: "github", leaf: "github", action: "read", wildcard: false, grantRoot: "github" },
});
const ghBranches = tool({
  name: "get_github_repos_by_owner_by_repo_branches",
  method: "GET",
  // per-repo list → has path params → NOT wildcard
  perm: { root: "github", leaf: "github", action: "list", wildcard: false, grantRoot: "github" },
});
const ghListAll = tool({
  name: "get_github_repos",
  method: "GET",
  // list ALL connected repos → no path params → wildcard (org-wide)
  perm: { root: "github", leaf: "github", action: "list", wildcard: true, grantRoot: "github" },
});
const projGet = tool({
  name: "get_projects_by_id",
  method: "GET",
  perm: { root: "project", leaf: "project", action: "read", wildcard: false, grantRoot: "project" },
});
const projUpdate = tool({
  name: "patch_projects_by_id",
  method: "PATCH",
  perm: { root: "project", leaf: "project", action: "write", wildcard: false, grantRoot: "project" },
});
const projList = tool({
  name: "get_projects",
  method: "GET",
  perm: { root: "project", leaf: "project", action: "list", wildcard: true, grantRoot: "project" },
});
const projCreate = tool({
  name: "post_projects",
  method: "POST",
  // collection create → wildcard, but reachable via the own-projects scope
  perm: { root: "project", leaf: "project", action: "write", wildcard: true, grantRoot: "project", projectCreate: true },
});

const ALL = [ghGetRepo, ghBranches, ghListAll, projGet, projUpdate, projList, projCreate];
const names = (tools: McpToolDef[]) => tools.map((t) => t.name).sort();

function principal(p: Partial<McpPrincipal>): McpPrincipal {
  return {
    role: p.role ?? "restricted",
    readOnly: p.readOnly ?? false,
    grantedRootTypes: p.grantedRootTypes ?? new Set(),
    canCreateProjects: p.canCreateProjects ?? false,
  };
}

describe("filterToolsForPrincipal", () => {
  it("owner sees everything", () => {
    const out = filterToolsForPrincipal(ALL, principal({ role: "owner" }));
    expect(out.length).toBe(ALL.length);
  });

  it("read-only token sees only GET tools", () => {
    const out = filterToolsForPrincipal(ALL, principal({ role: "owner", readOnly: true }));
    expect(names(out)).not.toContain("patch_projects_by_id");
    expect(out.every((t) => t.method === "GET")).toBe(true);
  });

  it("repo-scoped token sees per-repo GitHub tools but not the org-wide list", () => {
    const out = filterToolsForPrincipal(
      ALL,
      principal({ grantedRootTypes: new Set(["github_repository"]) }),
    );
    expect(names(out)).toContain("get_github_repos_by_owner_by_repo");
    expect(names(out)).toContain("get_github_repos_by_owner_by_repo_branches");
    // org-wide "list ALL repos" and any project tool stay hidden
    expect(names(out)).not.toContain("get_github_repos");
    expect(names(out)).not.toContain("get_projects_by_id");
  });

  it("installation- and org-wide github grants also satisfy github tools (grant family)", () => {
    for (const g of ["github_installation", "github"]) {
      const out = filterToolsForPrincipal(ALL, principal({ grantedRootTypes: new Set([g]) }));
      expect(names(out)).toContain("get_github_repos_by_owner_by_repo");
    }
  });

  it("project-scoped token sees per-project tools but not GitHub, the org list, or create", () => {
    const out = filterToolsForPrincipal(ALL, principal({ grantedRootTypes: new Set(["project"]) }));
    expect(names(out)).toContain("get_projects_by_id");
    expect(names(out)).toContain("patch_projects_by_id");
    expect(names(out)).not.toContain("get_projects"); // wildcard list
    expect(names(out)).not.toContain("post_projects"); // create needs the own-projects scope
    expect(names(out)).not.toContain("get_github_repos_by_owner_by_repo");
  });

  it("own-projects scope (canCreateProjects) sees create + the project list", () => {
    const out = filterToolsForPrincipal(
      ALL,
      principal({ grantedRootTypes: new Set(["project"]), canCreateProjects: true }),
    );
    expect(names(out)).toContain("post_projects"); // may create
    expect(names(out)).toContain("get_projects"); // may list (filtered to self-created)
    // still no GitHub, since no github grant
    expect(names(out)).not.toContain("get_github_repos_by_owner_by_repo");
  });
});
