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

const billingGet = tool({
  name: "get_billing",
  method: "GET",
  // org-singleton with no path params → wildcard, but reachable by a scoped token
  // holding {billing,"*"} since the restricted arm authorizes that directly.
  perm: { root: "billing", leaf: "billing", action: "read", wildcard: true, grantRoot: "billing" },
});

// Content-serving github tools. `source` marks them as needing a capability
// BEYOND the repo grant — a repo grant alone is deploy-only.
const ghFile = tool({
  name: "get_github_repos_by_owner_by_repo_file",
  method: "GET",
  perm: { root: "github", leaf: "github", action: "read", wildcard: false, grantRoot: "github", source: "content" },
});
const ghFiles = tool({
  name: "get_github_repos_by_owner_by_repo_files",
  method: "GET",
  perm: { root: "github", leaf: "github", action: "list", wildcard: false, grantRoot: "github", source: "content-tree" },
});
const ghDetect = tool({
  name: "get_github_repos_by_owner_by_repo_detect",
  method: "GET",
  // No `source` — derived config only, so it works on a deploy-only grant.
  perm: { root: "github", leaf: "github", action: "read", wildcard: false, grantRoot: "github" },
});

const ALL = [
  ghGetRepo, ghBranches, ghListAll, projGet, projUpdate, projList, projCreate, billingGet,
  ghFile, ghFiles, ghDetect,
];
const names = (tools: McpToolDef[]) => tools.map((t) => t.name).sort();

function principal(p: Partial<McpPrincipal>): McpPrincipal {
  return {
    role: p.role ?? "restricted",
    readOnly: p.readOnly ?? false,
    grantedRootTypes: p.grantedRootTypes ?? new Set(),
    canCreateProjects: p.canCreateProjects ?? false,
    sourceCapabilities: p.sourceCapabilities ?? new Set(),
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

  /**
   * Org-singleton wildcards are the mirror of the `github '*' not found` bug: once
   * the restricted arm of checkPermission authorizes {leaf,"*"} from a grant, a
   * blanket `wildcard → hidden` rule would hide tools the token CAN call. Listed
   * iff the grant is held — nothing more, nothing less.
   */
  it("a billing-granted scoped token SEES the org-singleton billing tool", () => {
    const out = filterToolsForPrincipal(ALL, principal({ grantedRootTypes: new Set(["billing"]) }));
    expect(names(out)).toContain("get_billing");
  });

  it("a scoped token without a billing grant never sees it", () => {
    for (const g of ["project", "github", "github_repository"]) {
      const out = filterToolsForPrincipal(ALL, principal({ grantedRootTypes: new Set([g]) }));
      expect(names(out), `grant=${g}`).not.toContain("get_billing");
    }
  });

  it("an all-github grant sees the org-wide repo list; a repo-scoped one does not", () => {
    const all = filterToolsForPrincipal(ALL, principal({ grantedRootTypes: new Set(["github"]) }));
    expect(names(all)).toContain("get_github_repos");

    const repoOnly = filterToolsForPrincipal(
      ALL,
      principal({ grantedRootTypes: new Set(["github_repository"]) }),
    );
    expect(names(repoOnly)).not.toContain("get_github_repos");
  });

  it("a LIST wildcard stays hidden even for a matching grant — no arm authorizes it", () => {
    const out = filterToolsForPrincipal(ALL, principal({ grantedRootTypes: new Set(["project"]) }));
    expect(names(out)).not.toContain("get_projects");
  });

  /**
   * Repo access is DEPLOY-ONLY by default. A token can hold a github grant and
   * still have no business reading files, so the content tools must not be
   * advertised to it — otherwise the agent tries them and gets a 404 it cannot
   * interpret, which is exactly the failure mode of the original bug.
   */
  it("a repo-granted but deploy-only token sees metadata + detect, NOT file content", () => {
    const out = filterToolsForPrincipal(
      ALL,
      principal({ grantedRootTypes: new Set(["github_repository"]) }),
    );
    expect(names(out)).toContain("get_github_repos_by_owner_by_repo");
    expect(names(out)).toContain("get_github_repos_by_owner_by_repo_branches");
    // detect is what lets it configure a deploy without content access
    expect(names(out)).toContain("get_github_repos_by_owner_by_repo_detect");
    // and the content tools stay hidden
    expect(names(out)).not.toContain("get_github_repos_by_owner_by_repo_file");
    expect(names(out)).not.toContain("get_github_repos_by_owner_by_repo_files");
  });

  it("a token WITH content capability sees the file tools", () => {
    const out = filterToolsForPrincipal(
      ALL,
      principal({
        grantedRootTypes: new Set(["github_repository"]),
        sourceCapabilities: new Set(["content"]),
      }),
    );
    expect(names(out)).toContain("get_github_repos_by_owner_by_repo_file");
    expect(names(out)).toContain("get_github_repos_by_owner_by_repo_files");
  });

  it("content capability does NOT imply write capability", () => {
    const writeTool = tool({
      name: "put_github_file",
      method: "PUT",
      perm: { root: "github", leaf: "github", action: "write", wildcard: false, grantRoot: "github", source: "write" },
    });
    const out = filterToolsForPrincipal(
      [...ALL, writeTool],
      principal({
        grantedRootTypes: new Set(["github_repository"]),
        sourceCapabilities: new Set(["content"]),
      }),
    );
    expect(names(out)).toContain("get_github_repos_by_owner_by_repo_file");
    expect(names(out)).not.toContain("put_github_file");
  });

  it("a non-restricted role is not hidden from content tools (its own role governs)", () => {
    // An owner's GitHub reach is resolved by github-access.ts, not by grants, so
    // hiding on an empty capability set would blank the tools for the org owner.
    const out = filterToolsForPrincipal(ALL, principal({ role: "owner" }));
    expect(names(out)).toContain("get_github_repos_by_owner_by_repo_file");
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
