import { describe, it, expect } from "vitest";
import type { Context } from "hono";
import {
  githubReadTarget,
  parsePermissionTag,
  getRouteRegistry,
  isPublicSpec,
} from "../../src/lib/route-permission";

/**
 * GitHub grants come at three widths — org-wide `github` ("*"), per-account
 * `github_installation` (owner login), per-repo `github_repository`
 * ("owner/repo"). `requirePermission` must resolve the caller's real width
 * through github-access.ts; it must NOT route these through the
 * ORG_SINGLETON_RESOURCES / isList paths, which assert
 * `{resourceType:"github", resourceId:"*"}`.
 *
 * That singleton assertion is unsatisfiable for a restricted principal at
 * EVERY width: `resolveResourceOrg` delegates "github" to `loadRootOrgId`,
 * which has no "github" case and returns null, so `checkPermission` denies no
 * matter which grant is held. Because `filterToolsForPrincipal` advertises
 * GitHub tools to any holder of a github-family grant, the mismatch made every
 * GitHub MCP tool listed-but-uncallable, failing with `github '*' not found`.
 *
 * These tests pin the routing decision that avoids that trap.
 */

/** Minimal Context stand-in — githubReadTarget only reads req.param(). */
const ctxWith = (params: Record<string, string>) =>
  ({ req: { param: (n: string) => params[n] } }) as unknown as Context;

/** Dummy value per `:param` in a registered path. */
const paramsOf = (path: string): Record<string, string> =>
  Object.fromEntries(
    (path.match(/:([A-Za-z0-9_]+)/g) ?? []).map((m) => [m.slice(1), `v-${m.slice(1)}`]),
  );

describe("githubReadTarget: routes that resolve by grant width", () => {
  it("matches a per-repo read and keys it owner/repo", () => {
    const t = githubReadTarget(
      parsePermissionTag("github:read"),
      ctxWith({ owner: "hydralerne", repo: "charts" }),
    );
    expect(t).toEqual({ owner: "hydralerne", repo: "charts", key: "hydralerne/charts" });
  });

  it("matches a per-repo list (branches, files, webhooks)", () => {
    const t = githubReadTarget(
      parsePermissionTag("github:list"),
      ctxWith({ owner: "hydralerne", repo: "charts" }),
    );
    expect(t?.key).toBe("hydralerne/charts");
  });

  it("matches /orgs/:org/repos on the `org` param, with no repo", () => {
    const t = githubReadTarget(parsePermissionTag("github:list"), ctxWith({ org: "hydralerne" }));
    expect(t).toEqual({ owner: "hydralerne", repo: null, key: "hydralerne" });
  });
});

describe("githubReadTarget: routes that stay on the org-wide path", () => {
  it("does NOT match write/admin — mutations still need owner role or an all-GitHub grant", () => {
    const params = { owner: "hydralerne", repo: "charts" };
    expect(githubReadTarget(parsePermissionTag("github:write"), ctxWith(params))).toBeNull();
    expect(githubReadTarget(parsePermissionTag("github:admin"), ctxWith(params))).toBeNull();
  });

  it("does NOT match paramless GitHub reads (/home, /status, /repos)", () => {
    expect(githubReadTarget(parsePermissionTag("github:read"), ctxWith({}))).toBeNull();
    expect(githubReadTarget(parsePermissionTag("github:list"), ctxWith({}))).toBeNull();
  });

  it("does NOT match non-GitHub tags that happen to carry an owner param", () => {
    expect(
      githubReadTarget(parsePermissionTag("project:read"), ctxWith({ owner: "x", repo: "y" })),
    ).toBeNull();
  });
});

/**
 * The ratchet: add a GitHub read/list route naming an owner and forget to make
 * it resolvable by width, and it would silently 404 for every scoped token.
 */
describe("every owner-scoped GitHub read route resolves by width", () => {
  it("leaves no owner-scoped GitHub read/list route on the unsatisfiable singleton path", async () => {
    // Importing the route module is what populates the registry.
    await import("../../src/modules/github/github.routes");

    const ownerScopedReads = getRouteRegistry().filter((r) => {
      if (isPublicSpec(r.spec)) return false;
      if (!r.spec.tag.startsWith("github:")) return false;
      const { action } = parsePermissionTag(r.spec.tag);
      if (action !== "read" && action !== "list") return false;
      return /:owner\b|:org\b/.test(r.path);
    });

    // Guard the guard: an empty registry would make this vacuously pass.
    expect(ownerScopedReads.length).toBeGreaterThanOrEqual(5);

    for (const route of ownerScopedReads) {
      const target = githubReadTarget(
        parsePermissionTag(route.spec.tag as string),
        ctxWith(paramsOf(route.path)),
      );
      expect(
        target,
        `${route.method} ${route.path} (${route.spec.tag}) would fall through to ` +
          `{github,"*"} and 404 for every scoped token`,
      ).not.toBeNull();
    }
  });
});
