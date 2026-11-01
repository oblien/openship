import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import { githubFetch } from "@repo/platform/engine/modules/github/github.auth";
import {
  GITHUB_BRANCH_PAGE_SIZE,
  getBranch,
  listBranches,
} from "@repo/platform/engine/modules/github/github.service";
import type { GitHubBranch } from "@repo/platform/engine/modules/github/github.types";

vi.mock("@repo/platform/engine/modules/github/github.auth", () => ({
  githubFetch: vi.fn(),
  getGitHubAuthMode: vi.fn(),
}));

const ctx = {} as RequestContext;
const branch = (name: string): GitHubBranch =>
  ({ name, commit: { sha: `sha-${name}` }, protected: false }) as GitHubBranch;

describe("listBranches", () => {
  beforeEach(() => {
    vi.mocked(githubFetch).mockReset();
  });

  it("requests one page", async () => {
    const branches = [branch("alpha"), branch("main")];
    vi.mocked(githubFetch).mockResolvedValue(branches);

    const result = await listBranches(ctx, "owner", "repo", { page: 2 });

    expect(githubFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { page: 2, per_page: GITHUB_BRANCH_PAGE_SIZE },
      }),
    );
    expect(result).toEqual({
      branches,
      page: 2,
      perPage: GITHUB_BRANCH_PAGE_SIZE,
      hasMore: false,
    });
  });

  it("reports another page when the current page is full", async () => {
    const branches = Array.from({ length: GITHUB_BRANCH_PAGE_SIZE }, (_, index) =>
      branch(`branch-${index}`),
    );
    vi.mocked(githubFetch).mockResolvedValue(branches);

    const result = await listBranches(ctx, "owner", "repo");

    expect(result.hasMore).toBe(true);
    expect(result.page).toBe(1);
  });

  it("verifies the named branch directly without accepting a tag or relying on the first page", async () => {
    vi.mocked(githubFetch).mockResolvedValue(branch("feature/beyond-page-one"));
    expect(await getBranch(ctx, "owner", "repo", "feature/beyond-page-one")).toMatchObject({
      name: "feature/beyond-page-one",
    });
    expect(githubFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.github.com/repos/owner/repo/branches/feature%2Fbeyond-page-one",
      }),
    );
  });

  it("distinguishes a missing branch from an unavailable provider", async () => {
    vi.mocked(githubFetch).mockRejectedValue(new Error("GitHub API error (404): Not Found"));
    expect(await getBranch(ctx, "owner", "repo", "missing")).toBeNull();
    vi.mocked(githubFetch).mockRejectedValue(new Error("GitHub API error (503): Unavailable"));
    await expect(getBranch(ctx, "owner", "repo", "main")).rejects.toThrow("503");
  });
});
