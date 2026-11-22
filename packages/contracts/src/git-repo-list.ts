import type { GitRepositorySummary } from "./git-types";

export type RepoVisibility = "all" | "public" | "private";
export type RepoSort = "updated" | "name" | "stars";

export interface RepoListParams {
  page?: number;
  /** Absent → no slicing: `data` is the full filtered set (MCP / legacy). */
  perPage?: number;
  search?: string;
  visibility?: RepoVisibility;
  sort?: RepoSort;
}

type ListableRepository = Pick<
  GitRepositorySummary,
  "name" | "description" | "private" | "stars" | "updated_at"
> & {
  /** GitHub also supplies this field on repository rows returned by older clients. */
  stargazers_count?: number;
};

export interface RepoListResult<T = GitRepositorySummary> {
  /** The requested page (or the full filtered set when unpaged). */
  data: T[];
  page: number;
  perPage: number;
  /** Repos matching search + visibility — drives the "N repositories" footer. */
  count: number;
  /** All repos for the owner, search-independent — the sidebar overview total. */
  total: number;
  publicCount: number;
  privateCount: number;
  totalPages: number;
}

const MAX_PER_PAGE = 100;

/**
 * Shared by API listings and pickers with an already-authorized catalog.
 * `count` reflects the active search+visibility (footer); `total` /
 * `publicCount` / `privateCount` are over the whole owner set (sidebar), so a
 * search never distorts the overview stats.
 */
export function paginateRepoList<T extends ListableRepository>(
  repos: T[],
  params: RepoListParams,
): RepoListResult<T> {
  const total = repos.length;
  const publicCount = repos.filter((r) => !r.private).length;
  const privateCount = total - publicCount;

  let list = repos;
  const query = params.search?.trim().toLowerCase();
  if (query) {
    list = list.filter(
      (r) => r.name?.toLowerCase().includes(query) || r.description?.toLowerCase().includes(query),
    );
  }
  if (params.visibility === "public") list = list.filter((r) => !r.private);
  else if (params.visibility === "private") list = list.filter((r) => r.private);

  const sort = params.sort ?? "updated";
  list = [...list].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "stars")
      return (b.stars ?? b.stargazers_count ?? 0) - (a.stars ?? a.stargazers_count ?? 0);
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  const count = list.length;

  // No page size → return everything (keeps the MCP `list repos` tool + any
  // legacy caller returning the whole set), but still with real counts.
  if (params.perPage === undefined || params.perPage <= 0) {
    return {
      data: list,
      page: 1,
      perPage: count,
      count,
      total,
      publicCount,
      privateCount,
      totalPages: 1,
    };
  }

  const perPage = Math.min(Math.max(1, Math.floor(params.perPage)), MAX_PER_PAGE);
  const totalPages = Math.max(1, Math.ceil(count / perPage));
  const page = Math.min(Math.max(1, Math.floor(params.page ?? 1)), totalPages);
  const start = (page - 1) * perPage;
  return {
    data: list.slice(start, start + perPage),
    page,
    perPage,
    count,
    total,
    publicCount,
    privateCount,
    totalPages,
  };
}
