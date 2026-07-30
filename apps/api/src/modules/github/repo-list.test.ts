import { describe, it, expect } from "vitest";
import { paginateRepoList } from "./repo-list";
import type { MappedRepository } from "./github.types";

function repo(overrides: Partial<MappedRepository>): MappedRepository {
  return {
    full_name: "owner/repo",
    name: "repo",
    owner: "owner",
    description: null,
    html_url: "",
    private: false,
    visibility: "public",
    default_branch: "main",
    language: null,
    size: 0,
    forks: 0,
    watchers: 0,
    stars: 0,
    license: null,
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2020-01-01T00:00:00Z",
    pushed_at: "2020-01-01T00:00:00Z",
    ...overrides,
  } as MappedRepository;
}

const REPOS: MappedRepository[] = [
  repo({ name: "alpha", private: false, stars: 5, updated_at: "2023-01-01T00:00:00Z" }),
  repo({ name: "bravo", private: true, stars: 50, updated_at: "2024-06-01T00:00:00Z", description: "an api service" }),
  repo({ name: "charlie", private: false, stars: 1, updated_at: "2022-01-01T00:00:00Z" }),
  repo({ name: "delta", private: true, stars: 20, updated_at: "2025-01-01T00:00:00Z" }),
  repo({ name: "echo", private: false, stars: 9, updated_at: "2021-01-01T00:00:00Z", description: "API gateway" }),
];

describe("paginateRepoList", () => {
  it("returns the full set with real counts when unpaged (MCP / legacy)", () => {
    const r = paginateRepoList(REPOS, {});
    expect(r.data).toHaveLength(5);
    expect(r.count).toBe(5);
    expect(r.total).toBe(5);
    expect(r.publicCount).toBe(3);
    expect(r.privateCount).toBe(2);
    expect(r.totalPages).toBe(1);
  });

  it("slices to the requested page and reports totalPages from count", () => {
    const p1 = paginateRepoList(REPOS, { page: 1, perPage: 2, sort: "name" });
    expect(p1.data.map((x) => x.name)).toEqual(["alpha", "bravo"]);
    expect(p1.count).toBe(5);
    expect(p1.totalPages).toBe(3);

    const p3 = paginateRepoList(REPOS, { page: 3, perPage: 2, sort: "name" });
    expect(p3.data.map((x) => x.name)).toEqual(["echo"]);
    expect(p3.page).toBe(3);
  });

  it("count follows search+visibility but total stays the owner-wide figure", () => {
    const r = paginateRepoList(REPOS, { search: "api", perPage: 10 });
    // 'bravo' (desc) + 'echo' (desc) match "api" case-insensitively.
    expect(r.count).toBe(2);
    // sidebar figures are search-independent.
    expect(r.total).toBe(5);
    expect(r.publicCount).toBe(3);
    expect(r.privateCount).toBe(2);
  });

  it("visibility filter narrows count, not total", () => {
    const r = paginateRepoList(REPOS, { visibility: "private", perPage: 10 });
    expect(r.count).toBe(2);
    expect(r.data.every((x) => x.private)).toBe(true);
    expect(r.total).toBe(5);
  });

  it("sorts by stars desc / name asc / updated desc", () => {
    expect(paginateRepoList(REPOS, { sort: "stars" }).data[0].name).toBe("bravo"); // 50
    expect(paginateRepoList(REPOS, { sort: "name" }).data[0].name).toBe("alpha");
    expect(paginateRepoList(REPOS, { sort: "updated" }).data[0].name).toBe("delta"); // 2025
  });

  it("clamps page and perPage to valid ranges", () => {
    const over = paginateRepoList(REPOS, { page: 99, perPage: 2, sort: "name" });
    expect(over.page).toBe(3); // clamped to last page
    const huge = paginateRepoList(REPOS, { page: 1, perPage: 9999 });
    expect(huge.perPage).toBe(100); // capped
    expect(huge.data).toHaveLength(5);
  });

  it("empty input yields zero counts, not a crash", () => {
    const r = paginateRepoList([], { page: 1, perPage: 20 });
    expect(r).toMatchObject({ data: [], count: 0, total: 0, publicCount: 0, privateCount: 0, totalPages: 1, page: 1 });
  });
});
