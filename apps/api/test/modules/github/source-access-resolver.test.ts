import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RequestContext } from "../../../src/lib/request-context";

/**
 * Source-scope resolution across the three grant widths.
 *
 * The rule under test is MOST-SPECIFIC-WINS, and it is a security property, not a
 * convenience: if resolution unioned every matching grant, an owner who granted
 * "the whole account, content everywhere" and then separately narrowed ONE repo to
 * `src/**` would find the narrow rule silently overridden by the broad one. The
 * most specific grant is the one the owner most recently reasoned about, so it
 * wins outright.
 */

// vi.mock is hoisted above module scope, so the spies it closes over must be too.
const { memberFind, listByToken, listByMember } = vi.hoisted(() => ({
  memberFind: vi.fn(),
  listByToken: vi.fn(),
  listByMember: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    member: { find: memberFind },
    patGrant: { listByToken, findForResource: vi.fn(async () => null) },
    resourceGrant: { listByMember, findForResource: vi.fn(async () => null) },
  },
}));

import {
  resolveSourceAccess,
  checkSourceTier,
  filterTreeEntries,
} from "../../../src/modules/github/github-access";

type G = {
  resourceType: string;
  resourceId: string;
  permissions: string[];
  scope?: { v: 1; read?: { paths: string[] }; write?: { paths: string[] } };
};

/** A scoped-token principal, so no owner auto-access applies. */
const scopedCtx = () =>
  ({
    userId: "u1",
    organizationId: "org1",
    tokenScope: { tokenId: "t1", scoped: true },
  }) as unknown as RequestContext;

/** A plain member session (not scoped, not owner). */
const memberCtx = () =>
  ({ userId: "u1", organizationId: "org1" }) as unknown as RequestContext;

const TARGET = { owner: "hydralerne", repo: "charts" };
const RW = ["read", "write"];

/**
 * Per-path read/write checks, asked through `checkSourceTier` — the SAME gate
 * requirePermission calls in production.
 *
 * These used to call `canReadRepoPath` / `canWriteRepoPath`, thin wrappers that no
 * production code ever invoked. Testing them proved a parallel implementation of
 * the rule rather than the enforced one, so the two could drift while this file
 * stayed green. The wrappers are gone; these route the same assertions at the tier
 * switch the middleware actually uses.
 */
const canRead = async (path: string) =>
  (await checkSourceTier(scopedCtx(), TARGET, "content", path)).ok;
const canWrite = async (path: string) =>
  (await checkSourceTier(scopedCtx(), TARGET, "write", path)).ok;

function grants(...gs: G[]) {
  listByToken.mockResolvedValue(gs as never);
  listByMember.mockResolvedValue(gs as never);
}

beforeEach(() => {
  memberFind.mockResolvedValue({ id: "m1", role: "member" } as never);
  grants();
});

describe("the default is metadata-only", () => {
  it("a repo grant with NO scope grants no content", async () => {
    grants({ resourceType: "github_repository", resourceId: "hydralerne/charts", permissions: RW });
    const access = await resolveSourceAccess(scopedCtx(), TARGET);
    expect(access).toEqual({ readPaths: [], writePaths: [] });
    expect(await canRead("package.json")).toBe(false);
  });

  it("no matching grant at all grants nothing", async () => {
    grants({ resourceType: "github_repository", resourceId: "someone/else", permissions: RW });
    expect(await resolveSourceAccess(scopedCtx(), TARGET)).toEqual({
      readPaths: [],
      writePaths: [],
    });
  });
});

describe("most-specific-wins across the three widths", () => {
  const narrowRepo: G = {
    resourceType: "github_repository",
    resourceId: "hydralerne/charts",
    permissions: RW,
    scope: { v: 1, read: { paths: ["src/**"] } },
  };
  const broadInstallation: G = {
    resourceType: "github_installation",
    resourceId: "hydralerne",
    permissions: RW,
    scope: { v: 1, read: { paths: ["**"] } },
  };
  const broadAll: G = {
    resourceType: "github",
    resourceId: "*",
    permissions: RW,
    scope: { v: 1, read: { paths: ["**"] } },
  };

  it("a repo grant beats a broader installation grant — narrow is NOT widened", async () => {
    grants(broadInstallation, narrowRepo);
    const access = await resolveSourceAccess(scopedCtx(), TARGET);
    expect(access.readPaths).toEqual(["src/**"]);
    expect(await canRead("src/a.ts")).toBe(true);
    expect(await canRead("package.json")).toBe(false);
  });

  it("a repo grant beats an all-github grant", async () => {
    grants(broadAll, narrowRepo);
    expect((await resolveSourceAccess(scopedCtx(), TARGET)).readPaths).toEqual(["src/**"]);
  });

  it("an installation grant beats an all-github grant", async () => {
    grants(broadAll, {
      resourceType: "github_installation",
      resourceId: "hydralerne",
      permissions: RW,
      scope: { v: 1, read: { paths: ["docs/**"] } },
    });
    expect((await resolveSourceAccess(scopedCtx(), TARGET)).readPaths).toEqual(["docs/**"]);
  });

  it("a scopeless repo grant beats a broad SCOPED one — the narrow row still wins", async () => {
    // The sharpest form of the rule: the most specific grant says "metadata only",
    // so that is the answer even though a broader grant would allow everything.
    grants(broadInstallation, {
      resourceType: "github_repository",
      resourceId: "hydralerne/charts",
      permissions: RW,
    });
    expect((await resolveSourceAccess(scopedCtx(), TARGET)).readPaths).toEqual([]);
  });

  it("falls back to the broader grant when no repo grant matches THIS repo", async () => {
    grants(broadInstallation, {
      resourceType: "github_repository",
      resourceId: "hydralerne/other",
      permissions: RW,
      scope: { v: 1, read: { paths: ["nope/**"] } },
    });
    expect((await resolveSourceAccess(scopedCtx(), TARGET)).readPaths).toEqual(["**"]);
  });
});

describe("the scope is the surface, the permissions are still the verb", () => {
  it("write paths on a read-only grant authorise nothing", async () => {
    grants({
      resourceType: "github_repository",
      resourceId: "hydralerne/charts",
      permissions: ["read"],
      scope: { v: 1, read: { paths: ["src/**"] }, write: { paths: ["src/**"] } },
    });
    const access = await resolveSourceAccess(scopedCtx(), TARGET);
    expect(access.readPaths).toEqual(["src/**"]);
    expect(access.writePaths).toEqual([]);
    expect(await canWrite("src/a.ts")).toBe(false);
  });

  it("write paths on a write grant do authorise", async () => {
    grants({
      resourceType: "github_repository",
      resourceId: "hydralerne/charts",
      permissions: RW,
      scope: { v: 1, write: { paths: ["src/gen/**"] } },
    });
    expect(await canWrite("src/gen/x.ts")).toBe(true);
    expect(await canWrite("src/hand.ts")).toBe(false);
  });
});

describe("owner auto-access", () => {
  it("a non-scoped org owner gets everything", async () => {
    memberFind.mockResolvedValue({ id: "m1", role: "owner" } as never);
    const access = await resolveSourceAccess(memberCtx(), TARGET);
    expect(access.readPaths).toEqual(["**"]);
  });

  it("a SCOPED token never inherits owner auto-access", async () => {
    memberFind.mockResolvedValue({ id: "m1", role: "owner" } as never);
    expect((await resolveSourceAccess(scopedCtx(), TARGET)).readPaths).toEqual([]);
  });

  it("a non-member gets nothing even as a bare session", async () => {
    memberFind.mockResolvedValue(null as never);
    expect((await resolveSourceAccess(memberCtx(), TARGET)).readPaths).toEqual([]);
  });
});

describe("checkSourceTier — per-route rules", () => {
  beforeEach(() => {
    grants({
      resourceType: "github_repository",
      resourceId: "hydralerne/charts",
      permissions: RW,
      scope: { v: 1, read: { paths: ["src/**"] } },
    });
  });

  it("content: only the granted path", async () => {
    expect((await checkSourceTier(scopedCtx(), TARGET, "content", "src/a.ts")).ok).toBe(true);
    expect((await checkSourceTier(scopedCtx(), TARGET, "content", "package.json")).ok).toBe(false);
  });

  it("content-tree: the root is listable, because it leads to src/", async () => {
    expect((await checkSourceTier(scopedCtx(), TARGET, "content-tree", "")).ok).toBe(true);
    expect((await checkSourceTier(scopedCtx(), TARGET, "content-tree", "src")).ok).toBe(true);
    expect((await checkSourceTier(scopedCtx(), TARGET, "content-tree", "docs")).ok).toBe(false);
  });

  it("content-whole: partial content must NOT satisfy a clone", async () => {
    expect((await checkSourceTier(scopedCtx(), TARGET, "content-whole", "")).ok).toBe(false);
    grants({
      resourceType: "github_repository",
      resourceId: "hydralerne/charts",
      permissions: RW,
      scope: { v: 1, read: { paths: ["**"] } },
    });
    expect((await checkSourceTier(scopedCtx(), TARGET, "content-whole", "")).ok).toBe(true);
  });

  it("a metadata-only grant fails every content tier", async () => {
    grants({ resourceType: "github_repository", resourceId: "hydralerne/charts", permissions: RW });
    for (const tier of ["content", "content-tree", "content-whole", "write"] as const) {
      expect((await checkSourceTier(scopedCtx(), TARGET, tier, "src/a.ts")).ok, tier).toBe(false);
    }
  });
});

describe("filterTreeEntries — the listing filter", () => {
  it("returns only what the scope permits", () => {
    const entries = [
      { path: "src", type: "dir" },
      { path: "docs", type: "dir" },
      { path: "package.json", type: "file" },
    ];
    const visible = filterTreeEntries(entries, ["src/**"], (e) => ({
      path: e.path,
      isDirectory: e.type === "dir",
    }));
    expect(visible.map((e) => e.path)).toEqual(["src"]);
  });

  it("an empty allow-list hides everything (fail closed)", () => {
    const entries = [{ path: "src", type: "dir" }];
    expect(
      filterTreeEntries(entries, [], (e) => ({ path: e.path, isDirectory: true })),
    ).toEqual([]);
  });

  /**
   * GitHub's contents API returns the BLOB (base64 content included) when the
   * requested path is a file, so /files can serve content. Classifying that entry
   * as a file matters: treated as a "directory", the ancestor rule would let a
   * path that merely LEADS to a grant through — and that path's blob would be
   * returned with its content. Marked as a file, it must be granted outright.
   */
  it("a single FILE entry needs a strict match, not the ancestor rule", () => {
    const asFile = (path: string) =>
      filterTreeEntries([{ path }], ["src/deep/a.ts"], (e) => ({
        path: e.path,
        isDirectory: false,
      }));
    // Granted outright → visible.
    expect(asFile("src/deep/a.ts")).toHaveLength(1);
    // Merely an ancestor of the grant → NOT visible as a file.
    expect(asFile("src")).toHaveLength(0);
    expect(asFile("src/deep")).toHaveLength(0);
    // Sibling inside an ancestor → not visible.
    expect(asFile("src/deep/secret.ts")).toHaveLength(0);
  });
});
