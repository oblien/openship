import { describe, it, expect } from "vitest";
import { getRouteRegistry, isPublicSpec } from "../../src/lib/route-permission";

/**
 * THE CONTENT-TIER RATCHET.
 *
 * A repo grant is metadata-only by default: it authorises deploying the repo,
 * reading its branches, and detecting its stack — NOT crawling its files. That
 * only holds while every content-serving route declares `source`. Ship one
 * without it and a deploy-only token silently regains full read access, because
 * `requirePermission` has nothing to enforce.
 *
 * ── Why this is a CLASSIFICATION check, not a name check ─────────────────────
 * This used to work only from path markers (/file, /tree, /archive …), which by
 * construction caught a new route only if someone happened to name it
 * conventionally. A `/raw`, `/download`, `/export` or `/source` route would have
 * shipped ungated with this suite green — the guard's coverage depended on the
 * vocabulary of the person adding the hole.
 *
 * So the primary assertion is now structural and total: EVERY github route must
 * be explicitly classified as either content (declares a `source` tier) or
 * metadata (listed in METADATA_ROUTES). A route that is neither fails, whatever
 * it is called — so adding one forces a deliberate decision instead of inheriting
 * a default that happens to be unsafe.
 *
 * Four directions in total:
 *   1. Every route is classified — no route can be silently neither.
 *   2. METADATA_ROUTES has no stale entries, so renaming a content route can't
 *      leave it matching an allowlist line that no longer describes it.
 *   3. A route whose NAME looks content-serving may not be on the metadata list —
 *      the old heuristic, kept because it catches the opposite mistake
 *      (mis-classifying a conventionally-named route on purpose).
 *   4. The tiers that exist today are pinned exactly, so a retag from `content`
 *      to nothing — or `content-whole` down to `content` — fails here.
 */

/**
 * Path shapes that serve repository bytes or directory entries. Deliberately
 * broader than what exists: anything matching these must be TIERED, never
 * metadata. (Coverage no longer depends on this list — assertion 1 does.)
 */
const CONTENT_PATH_MARKERS: RegExp[] = [
  /\/files?$/, //           /files (tree), /file (bytes)
  /\/clone-token$/, //      a clone reads everything
  /\/contents?\b/, //       GitHub's own naming
  /\/tree\b/,
  /\/blob\b/,
  /\/(tar|zip)ball\b/,
  /\/archive\b/,
  /\/raw\b/,
  /\/download\b/,
  /\/export\b/,
  /\/source\b/,
];

/** The tier each content route must carry. Update deliberately, never casually. */
const EXPECTED_TIERS: Record<string, string> = {
  "GET /api/github/repos/:owner/:repo/files": "content-tree",
  "GET /api/github/repos/:owner/:repo/tree": "content-tree",
  "GET /api/github/repos/:owner/:repo/file": "content",
  "GET /api/github/repos/:owner/:repo/clone-token": "content-whole",
};

/**
 * Routes that serve NO repository content and must stay reachable on a
 * metadata-only (deploy-only) grant.
 *
 * Adding a github route means adding it here or giving it a `source` tier. If you
 * are about to add a line to this list, the question to answer is: can a caller
 * with no content grant learn anything about the repo's FILES from the response?
 * If yes, it belongs in EXPECTED_TIERS instead.
 */
const METADATA_ROUTES: ReadonlySet<string> = new Set([
  // Connection / account state — nothing repo-scoped.
  "GET /api/github/status",
  "GET /api/github/local-status",
  "GET /api/github/connect/poll",
  "GET /api/github/connect/redirect",
  "GET /api/github/home",
  "POST /api/github/connect",
  "POST /api/github/disconnect",
  "POST /api/github/instance-token",
  // Repo discovery + metadata. `detect` returns DERIVED build config only — it is
  // what makes a deploy-only grant usable, and is asserted separately below.
  "GET /api/github/orgs/:org/repos",
  "GET /api/github/repos",
  "POST /api/github/repos",
  "GET /api/github/repos/:owner/:repo",
  "DELETE /api/github/repos/:owner/:repo",
  "GET /api/github/repos/:owner/:repo/branches",
  "GET /api/github/repos/:owner/:repo/detect",
  // Webhook wiring — push auto-deploy plumbing, no file bytes.
  "GET /api/github/repos/:owner/:repo/webhooks",
  "POST /api/github/repos/:owner/:repo/webhooks",
  "DELETE /api/github/repos/:owner/:repo/webhooks",
]);

async function githubRoutes() {
  // Importing the module is what populates the registry.
  await import("../../src/modules/github/github.routes");
  return getRouteRegistry().filter((r) => r.path.startsWith("/api/github/"));
}

function routeKey(r: { method: string; path: string }): string {
  return `${r.method} ${r.path}`;
}

function tierOf(spec: unknown): string | undefined {
  return isPublicSpec(spec as never) ? undefined : (spec as { source?: string }).source;
}

describe("every content-serving github route declares a source tier", () => {
  it("classifies EVERY github route as content or metadata — none may be neither", async () => {
    const routes = await githubRoutes();
    // Guard the guard: an empty registry would make this vacuously pass.
    expect(routes.length).toBeGreaterThanOrEqual(10);

    const unclassified = routes
      .filter((r) => !tierOf(r.spec) && !METADATA_ROUTES.has(routeKey(r)))
      .map(routeKey);

    expect(
      unclassified,
      "These github routes are neither tiered nor on the metadata allowlist. A route that " +
        "serves repository content without a `source` tier is readable by a deploy-only " +
        "token. Give it a tier, or add it to METADATA_ROUTES if it exposes no file data:\n  " +
        unclassified.join("\n  "),
    ).toEqual([]);
  });

  it("keeps the metadata allowlist free of stale entries", async () => {
    // A renamed/removed content route must not leave a line here that silently
    // stops describing anything — that would be a hole waiting for a name reuse.
    const live = new Set((await githubRoutes()).map(routeKey));
    const stale = [...METADATA_ROUTES].filter((k) => !live.has(k));
    expect(stale, `METADATA_ROUTES lists routes that no longer exist:\n  ${stale.join("\n  ")}`)
      .toEqual([]);
  });

  it("never lets a content-LOOKING route sit on the metadata allowlist", async () => {
    const routes = await githubRoutes();
    const contentish = routes.filter((r) => CONTENT_PATH_MARKERS.some((m) => m.test(r.path)));
    expect(contentish.length).toBeGreaterThanOrEqual(3);

    for (const route of contentish) {
      const key = routeKey(route);
      expect(
        METADATA_ROUTES.has(key),
        `${key} looks content-serving but is on the metadata allowlist`,
      ).toBe(false);
      expect(
        tierOf(route.spec),
        `${key} serves repository content but declares no \`source\` tier — a ` +
          `deploy-only token would be able to read it`,
      ).toBeDefined();
    }
  });

  it("pins the tier of each content route", async () => {
    const routes = await githubRoutes();
    for (const [key, expected] of Object.entries(EXPECTED_TIERS)) {
      const [method, path] = key.split(" ");
      const route = routes.find((r) => r.method === method && r.path === path);
      expect(route, `${key} is missing from the registry`).toBeDefined();
      const spec = route!.spec;
      const source = isPublicSpec(spec) ? undefined : spec.source;
      expect(source, `${key} must be tier "${expected}"`).toBe(expected);
    }
  });

  it("clone-token requires UNRESTRICTED content, not merely content", async () => {
    // A clone hands over every byte and cannot be path-filtered, so a caller
    // scoped to a subtree must not be able to mint one. If this ever relaxes to
    // "content", a src/**-scoped token could clone the whole repo.
    const routes = await githubRoutes();
    const cloneToken = routes.find((r) => r.path.endsWith("/clone-token"));
    const spec = cloneToken!.spec;
    expect(isPublicSpec(spec) ? undefined : spec.source).toBe("content-whole");
  });

  it("metadata routes stay untiered so deploy-only keeps working", async () => {
    // The whole point of deploy-only is that these still work with no content
    // grant. Tiering one of them by mistake would break configuring a deploy.
    const routes = await githubRoutes();
    for (const path of [
      "/api/github/repos/:owner/:repo",
      "/api/github/repos/:owner/:repo/branches",
      "/api/github/repos/:owner/:repo/detect",
      "/api/github/orgs/:org/repos",
    ]) {
      const route = routes.find((r) => r.method === "GET" && r.path === path);
      expect(route, `${path} is missing from the registry`).toBeDefined();
      const spec = route!.spec;
      expect(
        isPublicSpec(spec) ? undefined : spec.source,
        `${path} is metadata tier and must NOT require content access`,
      ).toBeUndefined();
    }
  });

  it("detect exists and is advertised — it is what makes deploy-only usable", async () => {
    // Without a derived-config endpoint, an agent on a deploy-only grant could not
    // configure a deploy at all and would be forced to ask for content access.
    const routes = await githubRoutes();
    const detect = routes.find((r) => r.path === "/api/github/repos/:owner/:repo/detect");
    expect(detect).toBeDefined();
    const spec = detect!.spec;
    expect(isPublicSpec(spec)).toBe(false);
    expect((spec as { mcp?: unknown }).mcp, "detect must be exposed as an MCP tool").toBeDefined();
  });
});
